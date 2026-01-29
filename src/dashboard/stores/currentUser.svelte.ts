export interface AdoUser {
  displayName: string;
  email: string;
  id: string;
}

let currentUser = $state<AdoUser | null>(null);
let loading = $state(false);

export function getCurrentUser() {
  return currentUser;
}

export function isLoading() {
  return loading;
}

export async function fetchCurrentUser() {
  loading = true;
  try {
    const res = await fetch('/api/ado/me');
    if (res.ok) {
      currentUser = await res.json();
    } else {
      currentUser = null;
    }
  } catch (err) {
    console.error('Failed to fetch current user:', err);
    currentUser = null;
  } finally {
    loading = false;
  }
}
