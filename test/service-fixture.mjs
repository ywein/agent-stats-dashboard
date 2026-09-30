// Test-only discovery replacement. The real OpenCode launcher and sync code run
// against our fixture HTTP service without discovering the user's live service.
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@opencode/client/service") {
			const source = `export const Service = {
                ensure: async () => ({ url: process.env.TEST_OPENCODE_URL }),
                headers: () => ({})
            };`;
			return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
