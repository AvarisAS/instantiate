export async function fetchUser(id: string) {
  try {
    const response = await fetch("/api/users/" + id);
    if (!response.ok) throw new Error("failed");
    return await response.json();
  } catch (e) {
    console.error(e);
    throw e;
  }
}

export function fetchAccount(id: string) {
  return fetch("/api/accounts/" + id)
    .then((r) => r.json())
    .catch(() => null);
}

export async function loadOrg(id: string) {
  try {
    const res = await fetch("/api/orgs/" + id);
    return await res.json();
  } catch {
    return null;
  }
}
