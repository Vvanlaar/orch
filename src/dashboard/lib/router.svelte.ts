const ROUTES = ['/', '/tickets', '/videoscan'] as const;
export type Route = (typeof ROUTES)[number];

function isRoute(path: string): path is Route {
  return (ROUTES as readonly string[]).includes(path);
}

function currentPath(): Route {
  const path = window.location.pathname;
  return isRoute(path) ? path : '/';
}

let route = $state<Route>(currentPath());

// Listen for browser back/forward
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    route = currentPath();
  });
}

export function getRoute(): Route {
  return route;
}

export function navigate(path: Route) {
  if (path === route) return;
  window.history.pushState(null, '', path);
  route = path;
}
