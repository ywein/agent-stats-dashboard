/** Read the URL at request creation so an in-flight request keeps its original scope. */
export function sourceScope(): string {
	const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.hash.split("?")[1]);
	const scope = new URLSearchParams();
	for (const key of ["sourceId", "clientType"]) if (params.has(key)) scope.set(key, params.get(key)!);
	return scope.toString();
}
