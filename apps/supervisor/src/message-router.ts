import { getDb } from "./db.js";
import { sendOperatorMessage } from "./operator-delivery.js";

const RELAY_HISTORY_LIMIT = 15;

interface InboundMessage {
  channel: string;
  content: string;
  created_at?: string;
  direction: string;
  id: string;
  metadata?: Record<string, unknown> | null;
  sender: string;
}

interface ConversationMessage {
  content: string;
  created_at?: string;
  direction: string;
  metadata?: Record<string, unknown> | null;
  sender: string;
  task_id?: string | null;
}

/**
 * Check for unprocessed inbound messages and create relay tasks for them.
 */
export async function routeMessages(): Promise<void> {
  const db = getDb();

  const { data: messages, error } = await db
    .from("messages")
    .select("*")
    .eq("processed", false)
    .eq("direction", "inbound")
    .neq("sender", "system")
    .order("created_at")
    .limit(10);

  if (error || !messages?.length) return;

  for (const msg of (messages || []) as InboundMessage[]) {
    if (shouldSkipRelayRouting(msg)) {
      await db
        .from("messages")
        .update({
          metadata: {
            ...(msg.metadata || {}),
            processed_reason: "internal_message_skipped",
            routed_via: "skipped",
          },
          processed: true,
        })
        .eq("id", msg.id)
        .eq("processed", false);
      continue;
    }

    const history = await loadRecentConversationMessages(msg);
    const relayRouting = await prepareRelayTaskRouting(msg, history);

    // Create a high-priority relay task
    const { data: relayTask, error: taskErr } = await db
      .from("tasks")
      .insert({
        acceptance_criteria: buildRelayAcceptanceCriteria(relayRouting),
        assigned_role: "relay",
        objective: relayRouting.objective,
        priority: "high",
        project_id: relayRouting.project?.id || null,
        state: "ready",
        title: `Process message: ${msg.content.slice(0, 50)}...`,
      })
      .select("id")
      .single();

    if (taskErr) {
      console.error(`Failed to create relay task for message ${msg.id}:`, taskErr);
      await sendOperatorMessage({
        content: `System alert: failed to route inbound operator message "${msg.content.slice(0, 80)}". Reason: ${taskErr.message}`,
        metadata: {
          delivery: "local",
          source_message_id: msg.id,
        },
        sender: "system",
        taskId: null,
      });
      continue;
    }

    if (relayTask?.id && relayRouting.requires_execution) {
      await createRelayExecutionRequirement(relayTask.id, relayRouting);
      if (relayRouting.missing_requested_services.length > 0) {
        await createRelayRequestedServiceRequirements(
          relayTask.id,
          relayRouting.missing_requested_services
        );
      }
    }

    if (relayTask?.id) {
      const relayAck = buildRelayAcknowledgementMessage(msg, relayRouting.requires_execution);
      await sendOperatorMessage({
        content: relayAck,
        metadata: {
          notification_key: `request-received:${relayTask.id}`,
          notification_type: "task_progress",
          operator_visible: true,
          relay_task_id: relayTask.id,
          relay_update_kind: "received",
          root_request_channel: msg.channel,
          source_message_id: msg.id,
          ...(readDeliveryChatId(msg.metadata) !== null
            ? { chat_id: readDeliveryChatId(msg.metadata) }
            : {}),
        },
        sender: "relay",
        taskId: relayTask.id,
      });
    }

    // Mark message as processed
    await db
      .from("messages")
      .update({
        metadata: {
          ...(msg.metadata || {}),
          relay_project_id: relayRouting.project?.id || null,
          relay_project_mode: relayRouting.project?.mode || null,
          routed_via: "relay",
        },
        processed: true,
        task_id: relayTask.id,
      })
      .eq("id", msg.id);
  }
}

function buildRelayAcknowledgementMessage(
  message: InboundMessage,
  requiresExecution: boolean
): string {
  if (requiresExecution) {
    return "I’ve got this. I’m routing the work now and I’ll keep you posted as it moves.";
  }

  return `I’ve got your ${message.channel === "telegram" ? "message" : "request"} and I’m handling it now.`;
}

function readDeliveryChatId(
  metadata: Record<string, unknown> | null | undefined
): number | string | null {
  if (typeof metadata?.chat_id === "number" || typeof metadata?.chat_id === "string") {
    return metadata.chat_id;
  }

  if (
    typeof metadata?.telegram_chat_id === "number" ||
    typeof metadata?.telegram_chat_id === "string"
  ) {
    return metadata.telegram_chat_id;
  }

  return null;
}

interface RelevantSkill {
  description: string;
  display_name: string;
  match_score?: number;
  name: string;
  required_services: string[];
  scope_id: string;
  scope_type: string;
  steps: Array<{ instruction: string; order: number }>;
  tags: string[];
  trigger_when: string;
  updated_at: string;
  use_count: number;
}

interface RelayProjectDecision {
  display_name: string;
  id: string;
  mode: "continued_conversation" | "existing_project" | "created_project";
  reason: string;
  slug: string;
}

interface RelayRoutingDecision {
  execution_reason: string;
  matched_skills: RelevantSkill[];
  missing_requested_services: RelayRequestedServiceNeed[];
  objective: string;
  project: RelayProjectDecision | null;
  recommended_role: string | null;
  recurring_automation_setup: boolean;
  requirements_walkthrough: boolean;
  requires_execution: boolean;
  teach_mode: boolean;
}

interface RelayRequestedServiceNeed {
  display_name: string;
  reason: string;
  service_name: string;
}

const REFERENCE_HOSTNAMES = new Set([
  "bitbucket.org",
  "developers.openai.com",
  "docs.anthropic.com",
  "docs.github.com",
  "docs.n8n.io",
  "github.com",
  "gitlab.com",
  "npmjs.com",
  "openai.com",
  "vercel.com",
]);

async function prepareRelayTaskRouting(
  message: InboundMessage,
  history: ConversationMessage[]
): Promise<RelayRoutingDecision> {
  const content = String(message.content || "").trim();
  const teachMode = detectRelayTeachMode(content);
  const matchedSkills = await loadRelayMatchedSkills(content);
  const missingRequestedServices = await loadRelayRequestedServiceNeeds(content);
  const executionDecision = classifyRelayExecutionRequest(
    content,
    matchedSkills,
    teachMode
  );
  const requirementsWalkthrough =
    !teachMode &&
    (looksLikeRequirementsWalkthroughRequest(content) ||
      missingRequestedServices.length > 0);
  const recurringAutomationSetup =
    !teachMode && looksLikeRecurringAutomationSetup(content);
  const defaultFreshRepoDeployTargets =
    !teachMode && shouldDefaultToFreshRepoAndDeploymentTargets(content);
  const mediaProductionRequest = looksLikeMediaProductionRequest(content);
  const recommendedRole =
    executionDecision.requiresExecution &&
    mediaProductionRequest &&
    missingRequestedServices.length === 0
      ? "builder"
      : executionDecision.recommendedRole;
  const project = await resolveRelayProject(
    message,
    history,
    executionDecision.requiresExecution
  );
  const transcript = [...history, {
    content,
    created_at: message.created_at,
    direction: "inbound",
    sender: message.sender,
  }]
    .map(formatConversationMessage)
    .join("\n");

  const objective = `Process this inbound message from ${message.sender} via ${message.channel}. Classify intent and route appropriately.

Current message:
${content}

Recent conversation transcript:
${transcript}

Routing reminders:
- If the request depends on a third-party service, account, API key, CDN, email provider, or similar credentialed integration, route to sage for a plan before builder implementation unless the task already has a clear staged execution plan in context.
- If the message states a stable operator preference or constraint, record it as durable memory. Do not store secrets in memory.
- If the request creates or removes a public hostname, treat route activation or teardown plus external verification as required work, not optional follow-up.
- If the request is multi-phase, prefer a staged task graph with explicit depends_on prerequisites so follow-up work waits automatically instead of starting in parallel by accident.
- Treat projects as internal persistent initiatives, not operator setup work. Reuse an existing project when this message continues the same website, customer implementation, campaign, or product surface. If execution work starts a new durable initiative with a stable identifier such as a hostname, site, or named initiative, create or attach a project automatically so follow-up tasks, artifacts, memories, and skills stay grouped over time.
- If the message begins with "Remember:", "Always:", "Rule:", or a "When...do..." procedure, treat it as explicit training. Also treat repeated requests, recurring scheduled work, and proven multi-step workflows as candidates for shared skills. Create a semantic memory for durable facts and constraints, or a shared skill for repeatable procedures, then confirm back to the operator what was stored.
- If the message repeats work that previously failed or stalled, do not route it as a blind retry. Tell the next role to inspect prior handoff notes and choose a materially different approach.
- If matched shared skills are listed below and one clearly applies, reference it explicitly when you create downstream work so execution roles can reuse the existing procedure instead of recreating it.
- When execution is required, direct response alone is insufficient. Create at least one downstream child task for the appropriate role and reference the matched skill by name when applicable.
- If the operator explicitly asks what inputs, access, credentials, tools, accounts, or decisions you still need, answer that directly in the next operator-facing reply with a concrete checklist. Do not respond only with a vague planning acknowledgement.
- Default operator-facing delivery back to the same channel the request came from unless the operator explicitly asked for a different destination.
- If a recurring request says "my time" and there is no stored operator timezone, use the runtime timezone as the default assumption and say so instead of blocking just to ask.
- If the operator explicitly asks you to set up a recurring schedule or automation, that counts as authorization to enable it once real blockers are cleared. Do not create a confirmation-only follow-up just to repeat the same source channel or timezone assumption.

Matched shared skills for this message:
${formatRelayMatchedSkills(matchedSkills)}

Project persistence:
${formatRelayProjectDecision(project)}

Repo and deployment target defaults:
${
  defaultFreshRepoDeployTargets
    ? `- The operator asked for GitHub push and Vercel deployment but did not name an existing target.
- If active access is available, default to creating a new repo and a new Vercel project for this initiative instead of blocking only to ask which existing target to reuse.
- Only ask the operator to choose a target when they explicitly want to reuse an existing repo/project/team or live service inspection exposes multiple plausible destinations that genuinely need operator choice.`
    : "- No special repo/deployment-target default applies."
}

Teach mode detected: ${teachMode ? "yes" : "no"}.
Execution request detected: ${executionDecision.requiresExecution ? "yes" : "no"}.
Requirements walkthrough requested: ${requirementsWalkthrough ? "yes" : "no"}.
Recommended downstream role: ${executionDecision.recommendedRole || "none"}.
Effective downstream role: ${recommendedRole || "none"}.
Routing requirement: ${
  executionDecision.requiresExecution
    ? "Create at least one downstream child task before completing this relay task."
    : "Direct answer is allowed when confidence is high."
}

Requirements-walkthrough handling:
${
  requirementsWalkthrough
    ? `- The operator explicitly asked what else the system needs.
- Your next operator-facing reply must list the missing inputs, credentials, tools, accounts, decisions, or repo checks concretely.
- Group the list into what is required now, what will be needed later, and what is optional but helpful when possible.
- If nothing else is needed, say that plainly instead of deferring.
- You may still create downstream planning work if helpful, but do not hide behind "I'll make a plan and get back to you."`
    : "- No explicit requirements walkthrough was requested."
}

Requested-service preflight:
${
  missingRequestedServices.length > 0
    ? `${missingRequestedServices
        .map(
          (service) =>
            `- Missing required service now: ${service.display_name} (${service.service_name}) because ${service.reason}.`
        )
        .join("\n")}
- Your next operator-facing reply must call these out as required now. Do not say that nothing else is required to start while these requested production services are missing.
- Create or confirm the Service Connections placeholders for the missing services before you finish the relay task.`
    : mediaProductionRequest
      ? `- The requested production media services appear to be available already.
- Route this into live asset creation, not a planning-only memo.
- Do not create a downstream task that only drafts concepts, prompt starters, or scripts when the operator asked for generated media and the services are active.
- The downstream task should call the active media service tools, generate the requested outputs, save the resulting files in the workspace, and register usable artifacts for operator delivery.
- If live generation fails, report the concrete service or API blocker instead of silently downgrading the request into an ideation-only deliverable.`
      : "- No missing requested production services were inferred from the message."
}

Recurring automation handling:
${
  recurringAutomationSetup
    ? `- The operator asked for live recurring execution, not a design memo.
- Use the relay task for intake, dry-run examples, and operator updates; put the privileged live schedule or automation mutation in the downstream execution task instead of trying to finish it inside relay.
- Create downstream work that configures or updates the actual live schedule or automation in this run when the runtime and tools support it.
- A dry-run example, reusable skill, or implementation note may accompany the work, but none of those replace the live enabled schedule or automation.
- Only stop at a blocker when a real missing service, credential, policy decision, or business input remains after applying the default source-channel and timezone assumptions already described above.
- If the recurring work is implemented as an internal platform schedule or other privileged control-plane mutation, route it through architect for live execution, not for design-only analysis.`
    : "- No special recurring automation contract applies."
}`;

  return {
    execution_reason: executionDecision.reason,
    matched_skills: matchedSkills,
    missing_requested_services: missingRequestedServices,
    objective,
    project,
    recommended_role: recommendedRole,
    recurring_automation_setup: recurringAutomationSetup,
    requirements_walkthrough: requirementsWalkthrough,
    requires_execution: executionDecision.requiresExecution,
    teach_mode: teachMode,
  };
}

function buildRelayAcceptanceCriteria(relayRouting: RelayRoutingDecision): string[] {
  if (relayRouting.requires_execution) {
    const criteria = [
      "Message classified",
      "Durable initiative continued or attached when appropriate",
      "Appropriate downstream child task created",
      "Operator kept informed without falsely claiming the work is already complete",
    ];

    if (relayRouting.requirements_walkthrough) {
      criteria.splice(
        3,
        0,
        "Operator received a concrete checklist of missing inputs, tools, credentials, or decisions"
      );
    }

    if (relayRouting.recurring_automation_setup) {
      criteria.splice(
        criteria.length - 1,
        0,
        "Live recurring schedule or automation configured and enabled, or a concrete blocker recorded after applying the default channel and timezone assumptions"
      );
    }

    return criteria;
  }

  if (relayRouting.requirements_walkthrough) {
    return [
      "Message classified",
      "Concrete requirements checklist sent to the operator",
      "Response sent",
    ];
  }

  return [
    "Message classified",
    "Appropriate action taken or task created",
    "Response sent",
  ];
}

async function createRelayExecutionRequirement(
  taskId: string,
  relayRouting: RelayRoutingDecision
): Promise<void> {
  const db = getDb();
  const { error } = await db.from("task_requirements").insert({
    task_id: taskId,
    requirement_type: "downstream_task",
    target: "execution",
    expected: {
      execution_reason: relayRouting.execution_reason,
      matched_skill_names: relayRouting.matched_skills.map((skill) => skill.name),
      recommended_role: relayRouting.recommended_role || "builder",
    },
    status: "pending",
    required_for_completion: true,
    last_result: {},
  });

  if (error) {
    console.error(
      `Failed to create downstream-task requirement for relay task ${taskId}:`,
      error
    );
  }
}

async function createRelayRequestedServiceRequirements(
  taskId: string,
  requestedServices: RelayRequestedServiceNeed[]
): Promise<void> {
  const db = getDb();

  for (const service of requestedServices) {
    const { data: existingService, error: loadError } = await db
      .from("service_registry")
      .select("id,status")
      .eq("service_name", service.service_name)
      .maybeSingle<{ id: string; status: string }>();

    if (loadError) {
      console.error(
        `Failed to inspect relay preflight service '${service.service_name}':`,
        loadError
      );
      continue;
    }

    if (!existingService) {
      const { error: insertServiceError } = await db.from("service_registry").insert({
        auth_type: "api_key",
        base_url: null,
        credential: null,
        description: service.reason,
        display_name: service.display_name,
        service_name: service.service_name,
        status: "key_needed",
      });

      if (insertServiceError) {
        console.error(
          `Failed to register relay preflight service '${service.service_name}':`,
          insertServiceError
        );
      }
    }

    const { error: requirementError } = await db.from("task_requirements").insert({
      expected: {
        allow_statuses: ["active"],
        display_name: service.display_name,
        note: service.reason,
      },
      last_result: {
        checked_at: new Date().toISOString(),
        service_status: existingService?.status || "key_needed",
      },
      required_for_completion: true,
      requirement_type: "service_active",
      status: "blocked",
      target: service.service_name,
      task_id: taskId,
    });

    if (requirementError) {
      console.error(
        `Failed to register relay preflight task requirement for '${service.service_name}':`,
        requirementError
      );
    }
  }
}

function shouldSkipRelayRouting(message: InboundMessage): boolean {
  return (
    message.sender === "system" ||
    message.metadata?.hidden_from_operator === true ||
    message.metadata?.operator_visible === false ||
    message.metadata?.routed_via === "relay"
  );
}

function detectRelayTeachMode(content: string): boolean {
  return /^(remember:|always:|rule:|when\b.+\bdo\b)/i.test(content);
}

async function loadRelayRequestedServiceNeeds(
  content: string
): Promise<RelayRequestedServiceNeed[]> {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return [];
  }

  const requestedServices: RelayRequestedServiceNeed[] = [];
  const activeServices = await loadActiveRelayServiceNames();
  const requestsImageAssets = shouldRequireImageServiceNow(normalized);
  const requestsVoiceAssets =
    /\b(voiceover|voice-over|voice over|audio|spoken|narration|narrator)\b/i.test(
      normalized
    );

  if (requestsImageAssets && !activeServices.has("gemini")) {
    requestedServices.push({
      display_name: "Gemini",
      reason:
        "the request includes image or visual asset deliverables that need an image-generation service for production output",
      service_name: "gemini",
    });
  }

  if (requestsVoiceAssets && !activeServices.has("elevenlabs")) {
    requestedServices.push({
      display_name: "ElevenLabs",
      reason:
        "the request includes a voiceover or audio deliverable that needs a voice-generation service for production output",
      service_name: "elevenlabs",
    });
  }

  return requestedServices;
}

function looksLikeMediaProductionRequest(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return false;
  }

  return (
    /\b(image|images|visual|visuals|graphic|graphics|creative|creatives|thumbnail|banner|illustration|ad creative)\b/i.test(
      normalized
    ) &&
    /\b(asset pack|campaign|ad|promo|prepare|create|generate|need|want)\b/i.test(
      normalized
    )
  );
}

function shouldDefaultToFreshRepoAndDeploymentTargets(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return false;
  }

  const requestsGithub =
    /\b(github|repo|repository)\b/i.test(normalized) &&
    /\b(push|commit|publish|ship|create)\b/i.test(normalized);
  const requestsVercel =
    /\b(vercel|deploy|deployment|preview)\b/i.test(normalized);
  const explicitlyReusesExistingTarget =
    /\b(use|reuse|update|deploy to)\s+(?:an?\s+)?(?:existing\s+|current\s+)?(?:repo|repository|project|team)\b/i.test(
      normalized
    ) ||
    /\bexisting\s+(?:repo|repository|project|team)\b/i.test(normalized);

  return requestsGithub && requestsVercel && !explicitlyReusesExistingTarget;
}

function looksLikeOptionalVisualSupportRequest(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bif (?:it )?(?:helps|helpful|useful|needed)\b[^.!?\n]{0,160}\b(?:generate|create|use)\b[^.!?\n]{0,120}\b(?:replacement\s+)?(?:visuals?|images?|graphics?)\b/i.test(
      normalized
    ) ||
    /\byou (?:can|could)\s+also\b[^.!?\n]{0,160}\b(?:generate|create|use)\b[^.!?\n]{0,120}\b(?:replacement\s+)?(?:visuals?|images?|graphics?)\b/i.test(
      normalized
    ) ||
    /\boptional\b[^.!?\n]{0,120}\b(?:visuals?|images?|graphics?)\b/i.test(
      normalized
    )
  );
}

function shouldRequireImageServiceNow(content: string): boolean {
  return (
    looksLikeMediaProductionRequest(content) &&
    !looksLikeOptionalVisualSupportRequest(content)
  );
}

async function loadActiveRelayServiceNames(): Promise<Set<string>> {
  const db = getDb();
  const { data, error } = await db
    .from("service_registry")
    .select("service_name")
    .eq("status", "active")
    .returns<Array<{ service_name: string }>>();

  if (error || !data?.length) {
    return new Set();
  }

  return new Set(
    data
      .map((row) => String(row.service_name || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function classifyRelayExecutionRequest(
  content: string,
  matchedSkills: RelevantSkill[],
  teachMode: boolean
): {
  reason: string;
  recommendedRole: string | null;
  requiresExecution: boolean;
} {
  if (teachMode) {
    return {
      reason: "explicit_training",
      recommendedRole: null,
      requiresExecution: false,
    };
  }

  if (looksLikeConversationProbe(content)) {
    return {
      reason: "conversation_probe",
      recommendedRole: null,
      requiresExecution: false,
    };
  }

  const imperativeLead =
    /^(please\s+)?(do|run|handle|follow|use|apply|execute|perform|send|deploy|fix|update|create|remove|delete|verify|check|review|build|make|treat)\b/i.test(
      content
    );
  const actionPhrase =
    /\b(please|go ahead|follow the|use the|apply the|run the|execute the|handle this|do this|verify this|treat this as|ship this|deploy this|fix this|update this|create this|remove this)\b/i.test(
      content
    );
  const informationalQuestion = looksLikeInformationalRelayQuestion(content);
  const requiresExecution = imperativeLead || actionPhrase || !informationalQuestion;

  return {
    reason: requiresExecution
      ? imperativeLead || actionPhrase
        ? matchedSkills.length
          ? "matched_skill_action_request"
          : "general_action_request"
        : matchedSkills.length
          ? "matched_skill_non_question"
          : "general_non_question_request"
      : matchedSkills.length
        ? "matched_skill_information_request"
        : "general_information_request",
    recommendedRole: requiresExecution
      ? determineRelayRecommendedRole(matchedSkills, content)
      : null,
    requiresExecution,
  };
}

function looksLikeConversationProbe(content: string): boolean {
  const normalized = String(content || "").trim().toLowerCase();
  if (!normalized || normalized.length > 140) {
    return false;
  }

  const probePhrase =
    /\b(quick test|test message|test from telegram|just testing|can you respond|can you reply|did you get this|are you there|do you see this)\b/.test(
      normalized
    ) ||
    (/^(hi|hello|hey|ping|test|testing)\b/.test(normalized) &&
      normalized.length <= 80);

  if (!probePhrase) {
    return false;
  }

  return !/\b(deploy|build|create|remove|delete|fix|update|verify|review|plan|investigate|publish|implement|child task|task graph)\b/.test(
    normalized
  );
}

function looksLikeInformationalRelayQuestion(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized.endsWith("?")) {
    return false;
  }

  return (
    /^(what|why|how|when|where|who|which|is|are|does|do|did|can|could|would|should|will)\b/i.test(
      normalized
    ) &&
    !/\b(use|follow|apply|run|execute|handle|do|send|fix|update|create|remove|deploy|verify|build|make|treat)\b/i.test(
      normalized
    )
  );
}

function looksLikeRequirementsWalkthroughRequest(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return false;
  }

  if (
    /\b(what (?:other )?(?:information|info|details|inputs?|tools|access|accounts?|credentials?|tokens|services) do you (?:think you )?need|what else do you need(?: from me)?|what do you need from me|anything else you need|if there is anything you (?:genuinely |actually )?need(?: from me| from us| from the account| from the service)?|which (?:tools|accounts?|credentials?|tokens|access) do you need|list (?:what|everything) you need|tell me exactly what (?:you need|it is)|tell me what you need|go through everything else you need|let'?s go through everything else you need)\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (
    /\bif\b.{0,120}\byou need\b.{0,120}\bask\b.{0,80}\bexactly what you need\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  return (
    /\b(before (?:you )?(?:start|begin|implement|build|ship)|to get started|to move forward)\b/i.test(
      normalized
    ) &&
    /\b(what|which|list|tell me|do you need)\b/i.test(normalized)
  );
}

function looksLikeRecurringAutomationSetup(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return false;
  }

  const mentionsRecurringWork =
    /\b(schedule|scheduled|recurring|automation|workflow|cron|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|week|month)|daily|weekly|monthly)\b/i.test(
      normalized
    );
  const mentionsActivation =
    /\b(set up|setup|configure|create|start|send|run|automate|enable|turn on|activate)\b/i.test(
      normalized
    );

  return mentionsRecurringWork && mentionsActivation;
}

function determineRelayRecommendedRole(
  matchedSkills: RelevantSkill[],
  content: string
): string {
  const requiresRecurringAutomationSetup = looksLikeRecurringAutomationSetup(content);
  const credentialedExecutionFollowUp =
    looksLikeCredentialedExecutionFollowUp(content);
  const requiresService =
    matchedSkills.some((skill) => skill.required_services.length > 0) ||
    /\b(api key|api keys|credential|credentials|login|oauth|token|tokens|service connection|service slot|github|gitlab|bitbucket|vercel|netlify|cloudflare|stripe|sendgrid|resend|smtp|cdn|dns|domain|account access|deployment account|repo access|gohighlevel|highlevel|leadconnector|elevenlabs|gemini)\b/i.test(
      content
    ) ||
    /\b(image|images|voice|voiceover|voice-over|audio|video|media|generation)\b.{0,80}\b(service|services|provider|providers|tool|tools)\b/i.test(
      content
    );

  if (requiresService) {
    if (credentialedExecutionFollowUp) {
      return "builder";
    }
    return "sage";
  }

  if (requiresRecurringAutomationSetup) {
    return "architect";
  }

  return "builder";
}

function looksLikeCredentialedExecutionFollowUp(content: string): boolean {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return false;
  }

  const serviceReadySignal =
    /\b(service connection|integration|account access|account connection).*(already (?:set up|configured|connected|active|available|in the system))\b/i.test(
      normalized
    ) ||
    /\byes,\s+the .*?(service connection|integration).*(already (?:set up|configured|connected|active|available|in the system))\b/i.test(
      normalized
    ) ||
    /\b(?:use|apply|route|set|move|treat)\b.*\b(location|account|integration|service)\b.*\balready (?:connected|configured|active|available)\b/i.test(
      normalized
    ) ||
    /\b(?:connected|configured|active|available)\b.*\b(location|account|integration|service)\b/i.test(
      normalized
    );
  const detailSignals = [
    /\b(location id|workspace id|project id|pipeline name|stage|tag|timezone|business hours|after hours|sending line|send(?:ing)? number|hostname|subdomain|repo name|branch name|voice id|campaign)\b/i,
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|weekdays?)\b/i,
    /"(?:[^"\r\n]{2,})"/,
    /\b(?:create|use|apply|draft|send from|follow-up|callback)\b/i,
  ].reduce((count, pattern) => count + (pattern.test(normalized) ? 1 : 0), 0);
  const scopedIdSignal =
    /\b(location id|workspace id|project id|pipeline id|stage id|voice id)\b/i.test(
      normalized
    );
  const executionContinuationSignal =
    /\b(pipeline|stage|tag|business hours|after hours|timezone|voicemail|follow-up|queue|inbound numbers?)\b/i.test(
      normalized
    ) && /\b(use|apply|create|treat|move|route)\b/i.test(normalized);

  return (
    (serviceReadySignal || scopedIdSignal) && detailSignals >= 2
  ) || (executionContinuationSignal && detailSignals >= 3);
}

async function loadRelayMatchedSkills(content: string): Promise<RelevantSkill[]> {
  if (!content.trim()) {
    return [];
  }

  const db = getDb();
  const { data, error } = await db
    .from("memories")
    .select("id,subject,content,tags,scope_type,scope_id,updated_at,is_active")
    .eq("layer", "procedural")
    .eq("is_active", true)
    .contains("tags", ["skill"])
    .in("scope_type", ["company", "role"])
    .returns<SkillMemoryRow[]>();

  if (error) {
    console.error("Failed to load relay skill matches:", error);
    return [];
  }

  return (data || [])
    .filter((memory) =>
      memory.scope_type === "company" ||
      (memory.scope_type === "role" && memory.scope_id === "relay")
    )
    .map((memory) => toRelevantSkill(memory))
    .map((skill) => ({
      ...skill,
      match_score: scoreRelaySkillMatch(skill, content),
    }))
    .filter((skill) => skill.match_score > 0)
    .sort((left, right) => {
      if (right.match_score !== left.match_score) {
        return right.match_score - left.match_score;
      }
      if (right.use_count !== left.use_count) {
        return right.use_count - left.use_count;
      }
      return right.updated_at.localeCompare(left.updated_at);
    })
    .slice(0, 3);
}

function formatRelayMatchedSkills(skills: RelevantSkill[]): string {
  if (!skills.length) {
    return "- No obvious shared skill match detected.";
  }

  return skills
    .map((skill) => {
      const steps = skill.steps
        .slice(0, 3)
        .map((step) => `${step.order}. ${step.instruction}`)
        .join(" ");
      return [
        `- ${skill.display_name} (${skill.name})`,
        skill.trigger_when ? `  Trigger: ${skill.trigger_when}` : null,
        steps ? `  Steps: ${steps}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function scoreRelaySkillMatch(
  skill: RelevantSkill,
  content: string
): number {
  const haystack = normalizeRelayMatchText(content);
  if (!haystack) {
    return 0;
  }

  const fields = [
    skill.name,
    skill.display_name,
    skill.description,
    skill.trigger_when,
    ...skill.tags,
    ...skill.steps.map((step) => step.instruction),
  ]
    .map((value) => normalizeRelayMatchText(value))
    .filter(Boolean);

  let score = 0;
  for (const field of fields) {
    if (haystack.includes(field) || field.includes(haystack)) {
      score += 6;
      continue;
    }

    const fieldTokens = new Set(tokenizeRelayMatchText(field));
    const sharedTokens = tokenizeRelayMatchText(haystack).filter((token) =>
      fieldTokens.has(token)
    );
    score += sharedTokens.length;
  }

  return score;
}

function normalizeRelayMatchText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s:-]+/g, " ");
}

function tokenizeRelayMatchText(value: string): string[] {
  return normalizeRelayMatchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

interface SkillMemoryRow {
  content: string;
  id: string;
  is_active: boolean;
  scope_id: string;
  scope_type: string;
  subject: string;
  tags: string[] | null;
  updated_at: string;
}

function toRelevantSkill(memory: SkillMemoryRow): {
  description: string;
  display_name: string;
  name: string;
  required_services: string[];
  scope_id: string;
  scope_type: string;
  steps: Array<{ instruction: string; order: number }>;
  tags: string[];
  trigger_when: string;
  updated_at: string;
  use_count: number;
} {
  const payload = parseSkillContent(memory.content);
  const name = memory.subject.replace(/^skill:/i, "").trim() || memory.subject.trim();

  return {
    description: readString(payload.description),
    display_name: readString(payload.display_name) || name,
    name,
    required_services: readStringArray(payload.required_services),
    scope_id: memory.scope_id,
    scope_type: memory.scope_type,
    steps: readSkillSteps(payload.steps),
    tags: readStringArray(payload.tags).length
      ? readStringArray(payload.tags)
      : memory.tags || [],
    trigger_when: readString(payload.trigger_when),
    updated_at: memory.updated_at,
    use_count: readPositiveInt(payload.use_count, 0),
  };
}

function parseSkillContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseInt(value, 10)
        : NaN;

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
}

function readSkillSteps(value: unknown): Array<{ instruction: string; order: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => {
      const step =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      const instruction = readString(step.instruction);
      if (!instruction) {
        return null;
      }

      return {
        instruction,
        order: readPositiveInt(step.order, index + 1),
      };
    })
    .filter((step): step is { instruction: string; order: number } => Boolean(step));
}

function formatConversationMessage(message: ConversationMessage): string {
  const timestamp = message.created_at
    ? new Date(message.created_at).toISOString()
    : "current";
  return `[${timestamp}] ${message.direction}/${message.sender}: ${message.content}`;
}

async function loadRecentConversationMessages(
  message: InboundMessage
): Promise<ConversationMessage[]> {
  const db = getDb();
  const chatId =
    message.channel === "telegram" &&
    (typeof message.metadata?.chat_id === "string" ||
      typeof message.metadata?.chat_id === "number")
      ? message.metadata.chat_id
      : null;
  let query = db
    .from("messages")
    .select("id,direction,sender,content,created_at,metadata,task_id")
    .eq("channel", message.channel)
    .neq("id", message.id)
    .order("created_at", { ascending: false })
    .limit(RELAY_HISTORY_LIMIT);

  if (chatId !== null) {
    query = query.contains("metadata", { chat_id: chatId });
  }

  const { data, error } = await query;

  if (error) {
    console.error(
      `Failed to load recent conversation history for message ${message.id}:`,
      error
    );
    return [];
  }

  return ((data || []) as ConversationMessage[])
    .filter((row) => isRelayVisibleConversationMessage(row))
    .reverse();
}

function isRelayVisibleConversationMessage(message: ConversationMessage): boolean {
  if (message.sender === "system") {
    return false;
  }

  return (
    message.metadata?.hidden_from_operator !== true &&
    message.metadata?.operator_visible !== false
  );
}

function formatRelayProjectDecision(project: RelayProjectDecision | null): string {
  if (!project) {
    return "- No persistent initiative is attached yet. If downstream execution reveals a stable ongoing initiative, attach it instead of leaving the work project-less.";
  }

  return [
    `- Attached project: ${project.display_name} (${project.slug})`,
    `- Mode: ${project.mode}`,
    `- Reason: ${project.reason}`,
    "- Keep follow-up tasks, artifacts, memories, and skills inside this project unless the scope clearly changes.",
  ].join("\n");
}

async function resolveRelayProject(
  message: InboundMessage,
  history: ConversationMessage[],
  requiresExecution: boolean
): Promise<RelayProjectDecision | null> {
  const signals = extractRelayProjectSignals(message.content);
  const existingProject = await findExistingProjectForSignals(signals);
  if (existingProject) {
    return {
      ...existingProject,
      mode: "existing_project",
    };
  }

  const recentConversationProject = await loadRecentConversationProject(history);
  if (
    recentConversationProject &&
    (
      (!signals.slug && !signals.hostnames.length && !signals.candidate_labels.length) ||
      scoreRelayProjectMatch(recentConversationProject, signals) >= 6
    )
  ) {
    return {
      display_name: recentConversationProject.display_name,
      id: recentConversationProject.id,
      mode: "continued_conversation",
      reason: "Recent messages in this conversation already belong to the same initiative.",
      slug: recentConversationProject.slug,
    };
  }

  if (!signals.slug && !signals.hostnames.length && !signals.candidate_labels.length) {
    return null;
  }

  if (!shouldAutoCreateRelayProject(signals, message.content, requiresExecution)) {
    return null;
  }

  const db = getDb();
  const createdProject = await createAutoManagedRelayProject(db, signals, message);
  if (!createdProject) {
    return null;
  }

  return {
    ...createdProject,
    mode: "created_project",
    reason: "Created a persistent initiative automatically so future work continues in the same context.",
  };
}

async function loadRecentConversationProject(
  history: ConversationMessage[]
): Promise<{
  display_name: string;
  id: string;
  metadata: Record<string, unknown> | null;
  reason: string;
  repo_url: string | null;
  slug: string;
} | null> {
  const db = getDb();
  const taskIds = [...new Set(
    [...history]
      .reverse()
      .flatMap((message) => {
        const directTaskId =
          typeof message.task_id === "string" && message.task_id ? message.task_id : null;
        const relayTaskId =
          typeof message.metadata?.relay_task_id === "string" && message.metadata.relay_task_id
            ? message.metadata.relay_task_id
            : null;
        return [directTaskId, relayTaskId].filter((value): value is string => Boolean(value));
      })
  )];

  if (!taskIds.length) {
    return null;
  }

  const { data: taskRows, error: taskError } = await db
    .from("tasks")
    .select("id,project_id")
    .in("id", taskIds)
    .returns<Array<{ id: string; project_id: string | null }>>();

  if (taskError) {
    console.error("Failed to inspect recent relay tasks for project continuity:", taskError);
    return null;
  }

  const projectIdByTaskId = new Map((taskRows || []).map((row) => [row.id, row.project_id]));
  const orderedProjectIds = taskIds
    .map((taskId) => projectIdByTaskId.get(taskId))
    .filter((value): value is string => Boolean(value));

  if (!orderedProjectIds.length) {
    return null;
  }

  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id,slug,display_name,metadata,repo_url")
    .eq("id", orderedProjectIds[0])
    .eq("archived", false)
    .maybeSingle<{
      display_name: string;
      id: string;
      metadata: Record<string, unknown> | null;
      repo_url: string | null;
      slug: string;
    }>();

  if (projectError) {
    console.error("Failed to load conversation continuation project:", projectError);
    return null;
  }

  if (!project) {
    return null;
  }

  return {
    ...project,
    reason: "Recent messages in this conversation already belong to this initiative.",
  };
}

function extractRelayProjectSignals(content: string): {
  candidate_labels: string[];
  hostnames: string[];
  slug: string | null;
} {
  const hostnames = extractInitiativeHostnames(content);
  const quotedLabels = [...String(content || "").matchAll(/["“]([^"\n]{3,60})["”]/g)]
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);
  const leadLabel = hostnames[0] || quotedLabels[0] || "";

  return {
    candidate_labels: [...new Set([...quotedLabels, ...hostnames].filter(Boolean))],
    hostnames,
    slug: leadLabel ? normalizeRelayProjectSlug(leadLabel) : null,
  };
}

function shouldAutoCreateRelayProject(
  signals: { candidate_labels: string[]; hostnames: string[]; slug: string | null },
  content: string,
  requiresExecution: boolean
): boolean {
  if (!requiresExecution || !signals.slug) {
    return false;
  }

  if (signals.hostnames.length > 0) {
    return true;
  }

  return (
    signals.candidate_labels.length > 0 &&
    /\b(site|website|app|project|campaign|customer|client|store|landing page|implementation)\b/i.test(
      content
    )
  );
}

async function findExistingProjectForSignals(signals: {
  candidate_labels: string[];
  hostnames: string[];
  slug: string | null;
}): Promise<{ display_name: string; id: string; reason: string; slug: string } | null> {
  const db = getDb();
  const { data, error } = await db
    .from("projects")
    .select("id,slug,display_name,repo_url,metadata,updated_at")
    .eq("archived", false)
    .order("updated_at", { ascending: false })
    .limit(200)
    .returns<
      Array<{
        display_name: string;
        id: string;
        metadata: Record<string, unknown> | null;
        repo_url: string | null;
        slug: string;
        updated_at: string;
      }>
    >();

  if (error) {
    console.error("Failed to load projects for relay initiative matching:", error);
    return null;
  }

  const ranked = (data || [])
    .map((project) => ({
      project,
      score: scoreRelayProjectMatch(project, signals),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!ranked.length || ranked[0].score < 6) {
    return null;
  }

  return {
    display_name: ranked[0].project.display_name,
    id: ranked[0].project.id,
    reason:
      ranked[0].score >= 10
        ? "Matched an existing initiative by hostname."
        : "Matched an existing initiative by slug or display name.",
    slug: ranked[0].project.slug,
  };
}

function scoreRelayProjectMatch(
  project: {
    display_name: string;
    metadata: Record<string, unknown> | null;
    repo_url: string | null;
    slug: string;
  },
  signals: { candidate_labels: string[]; hostnames: string[]; slug: string | null }
): number {
  let score = 0;
  const metadataHostnames = readProjectMetadataStringArray(project.metadata?.hostnames);
  const repoHostnames = extractHostnames(project.repo_url || "");
  const knownHostnames = new Set([...metadataHostnames, ...repoHostnames]);

  for (const hostname of signals.hostnames) {
    if (knownHostnames.has(hostname)) {
      score += 10;
      continue;
    }

    for (const knownHostname of knownHostnames) {
      score += scoreProbableHostnameTypo(hostname, knownHostname);
    }
  }

  if (signals.slug && project.slug === signals.slug) {
    score += 8;
  }

  const normalizedDisplayName = normalizeRelayProjectSlug(project.display_name);
  for (const label of signals.candidate_labels) {
    const normalizedLabel = normalizeRelayProjectSlug(label);
    if (!normalizedLabel) {
      continue;
    }

    if (normalizedDisplayName === normalizedLabel) {
      score += 6;
      continue;
    }

    if (
      normalizedDisplayName.includes(normalizedLabel) ||
      normalizedLabel.includes(normalizedDisplayName)
    ) {
      score += 3;
    }
  }

  return score;
}

function scoreProbableHostnameTypo(left: string, right: string): number {
  const normalizedLeft = normalizeRelayProjectSlug(left);
  const normalizedRight = normalizeRelayProjectSlug(right);
  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) {
    return 0;
  }

  if (Math.min(normalizedLeft.length, normalizedRight.length) < 8) {
    return 0;
  }

  const leftStem = extractHostnameStem(left);
  const rightStem = extractHostnameStem(right);
  if (!leftStem || leftStem !== rightStem) {
    return 0;
  }

  const distance = levenshteinDistance(normalizedLeft, normalizedRight);
  if (distance === 1) {
    return 7;
  }

  if (distance === 2 && sharesTldPrefix(left, right)) {
    return 6;
  }

  return 0;
}

async function createAutoManagedRelayProject(
  db: ReturnType<typeof getDb>,
  signals: { candidate_labels: string[]; hostnames: string[]; slug: string | null },
  message: InboundMessage
): Promise<{ display_name: string; id: string; reason: string; slug: string } | null> {
  if (!signals.slug) {
    return null;
  }

  const slug = await ensureUniqueProjectSlug(db, signals.slug);
  const displayName = signals.candidate_labels[0] || signals.slug;
  const { data, error } = await db
    .from("projects")
    .insert({
      description:
        `Auto-managed initiative created from an inbound ${message.channel} request. ` +
        "The system should continue related tasks, artifacts, memories, and skills here.",
      display_name: displayName,
      metadata: {
        auto_created_from: "relay",
        auto_managed: true,
        hostnames: signals.hostnames,
        last_inbound_channel: message.channel,
        last_inbound_sender: message.sender,
        last_routed_at: new Date().toISOString(),
      },
      slug,
    })
    .select("id,slug,display_name")
    .single<{ display_name: string; id: string; slug: string }>();

  if (error) {
    console.error("Failed to create auto-managed relay project:", error);
    return null;
  }

  return {
    ...data,
    reason: "Created a persistent initiative automatically so future work continues in the same context.",
  };
}

async function ensureUniqueProjectSlug(
  db: ReturnType<typeof getDb>,
  baseSlug: string
): Promise<string> {
  for (let suffix = 0; suffix < 20; suffix += 1) {
    const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix + 1}`;
    const { data, error } = await db
      .from("projects")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle<{ id: string }>();

    if (error) {
      throw new Error(`Failed to check project slug '${candidate}': ${error.message}`);
    }

    if (!data?.id) {
      return candidate;
    }
  }

  return `${baseSlug}-${Date.now()}`;
}

function normalizeRelayProjectSlug(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractHostnameStem(value: string): string {
  const hostname = extractHostnames(value)[0];
  if (!hostname) {
    return "";
  }

  const segments = hostname.split(".").filter(Boolean);
  if (segments.length <= 1) {
    return hostname;
  }

  return segments.slice(0, -1).join(".");
}

function sharesTldPrefix(left: string, right: string): boolean {
  const leftHostname = extractHostnames(left)[0];
  const rightHostname = extractHostnames(right)[0];
  if (!leftHostname || !rightHostname) {
    return false;
  }

  const leftTld = leftHostname.split(".").pop() || "";
  const rightTld = rightHostname.split(".").pop() || "";
  return leftTld.startsWith(rightTld) || rightTld.startsWith(leftTld);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex + 1;

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const temp = previous[rightIndex + 1];
      previous[rightIndex + 1] = Math.min(
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + 1,
        diagonal + (left[leftIndex] === right[rightIndex] ? 0 : 1)
      );
      diagonal = temp;
    }
  }

  return previous[right.length];
}

function extractHostnames(value: string): string[] {
  const hostnames = new Set<string>();
  for (const hostname of extractUrlHostnames(value)) {
    hostnames.add(hostname);
  }

  for (const match of String(value || "").matchAll(
    /(?:^|[\s(])(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=$|[\s),.:;!?])/gi
  )) {
    const rawHostname = String(match[1] || "").trim();
    if (!rawHostname || /[A-Z]/.test(rawHostname)) {
      continue;
    }

    const hostname = rawHostname.toLowerCase().replace(/^www\./, "");
    if (hostname) {
      hostnames.add(hostname);
    }
  }

  return [...hostnames];
}

function extractInitiativeHostnames(value: string): string[] {
  const hostnames = new Set<string>();

  for (const hostname of extractUrlHostnames(value)) {
    if (!isReferenceHostname(hostname)) {
      hostnames.add(hostname);
    }
  }

  for (const hostname of extractContextualBareHostnames(value)) {
    if (!isReferenceHostname(hostname)) {
      hostnames.add(hostname);
    }
  }

  return [...hostnames];
}

function extractUrlHostnames(value: string): string[] {
  const hostnames = new Set<string>();

  for (const match of String(value || "").matchAll(/https?:\/\/[^\s)]+/gi)) {
    try {
      const hostname = new URL(match[0]).hostname.trim().toLowerCase().replace(/^www\./, "");
      if (hostname) {
        hostnames.add(hostname);
      }
    } catch {
      // Ignore malformed URLs.
    }
  }

  return [...hostnames];
}

function extractContextualBareHostnames(value: string): string[] {
  const hostnames = new Set<string>();
  const content = String(value || "").replace(/\s+/g, " ");
  const patterns = [
    /\b(?:site|website|domain|hostname|homepage|landing page|public site|live site|client site|store|portal|blog)\b[^.\n]{0,80}?\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi,
    /\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b[^.\n]{0,80}?\b(?:site|website|domain|hostname|homepage|landing page|public site|live site|client site|store|portal|blog)\b/gi,
    /\b(?:live at|hosted at|published at|available at|reachable at)\s+(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const rawHostname = String(match[1] || "").trim();
      if (!rawHostname || /[A-Z]/.test(rawHostname)) {
        continue;
      }

      hostnames.add(rawHostname.toLowerCase().replace(/^www\./, ""));
    }
  }

  return [...hostnames];
}

function isReferenceHostname(hostname: string): boolean {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/^www\./, "");
  if (!normalized) {
    return false;
  }

  if (REFERENCE_HOSTNAMES.has(normalized)) {
    return true;
  }

  return Array.from(REFERENCE_HOSTNAMES).some(
    (referenceHost) => normalized === referenceHost || normalized.endsWith(`.${referenceHost}`)
  );
}

function readProjectMetadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter(Boolean)
    : [];
}

export const messageRouterTestHooks = {
  classifyRelayExecutionRequest,
  determineRelayRecommendedRole,
  extractHostnames,
  extractInitiativeHostnames,
  extractRelayProjectSignals,
  isReferenceHostname,
  looksLikeCredentialedExecutionFollowUp,
  looksLikeOptionalVisualSupportRequest,
  looksLikeRequirementsWalkthroughRequest,
  shouldDefaultToFreshRepoAndDeploymentTargets,
  shouldRequireImageServiceNow,
  scoreRelayProjectMatch,
  normalizeRelayProjectSlug,
  shouldAutoCreateRelayProject,
};
