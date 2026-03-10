let searchQuery = $state('');

export function getSearchQuery(): string {
  return searchQuery;
}

export function setSearchQuery(q: string) {
  searchQuery = q;
}

export function matchesSearch(query: string, ...fields: (string | number | undefined)[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some(f => f != null && String(f).toLowerCase().includes(q));
}
