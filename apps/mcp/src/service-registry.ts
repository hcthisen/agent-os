export interface ServiceRegistryCredentialRow {
  credential: string | null;
}

export async function decryptServiceCredential(
  credential: string | null
): Promise<string | null> {
  void credential;
  return null;
}

export async function withDecryptedCredential<T extends ServiceRegistryCredentialRow>(
  row: T | null
): Promise<T | null> {
  if (!row) {
    return null;
  }

  return {
    ...row,
    credential: await decryptServiceCredential(row.credential),
  };
}
