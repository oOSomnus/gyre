export default function (pi: any) {
	pi.registerCommand("pick-color", {
		description: "E2E: ask the user to pick a color",
		handler: async (_args: string, ctx: any) => {
			const choice = await ctx.ui.select("Pick a color", ["Red", "Green", "Blue"]);
			ctx.ui.notify(`picked=${choice ?? "none"}`, "info");
		},
	});
	pi.registerCommand("confirm-demo", {
		description: "E2E: ask for confirmation",
		handler: async (_args: string, ctx: any) => {
			const ok = await ctx.ui.confirm("Deploy?", "Ship it to production?");
			ctx.ui.notify(`confirmed=${ok}`, ok ? "info" : "warning");
		},
	});
}
