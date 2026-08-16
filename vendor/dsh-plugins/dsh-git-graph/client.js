window.__ModuleLoader__.load({
	id: "dsh-git-graph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css = [
			/* frame shared by the conversation view */
			".gg-frame{flex:1;width:100%;border:0;display:block;background:#0d1117;min-height:0}",
			/* conversation view (tab next to 轨迹) */
			".gg-view{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base, #0d1117)}",
			".gg-view .gg-frame{flex:1}"
		].join("");
		const tagId = "dsh-git-graph/style";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-git-graph";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		const graphSrc = (sid) => "/git-graph/index.html" + (sid ? "?sid=" + encodeURIComponent(sid) : "");

		/** Conversation view tab: the graph embedded in the session pane (next to 轨迹). */
		function GitGraphView(props) {
			const sid = props.sessionId || "";
			return react_jsx_runtime.jsx("div", {
				className: "gg-view",
				children: react_jsx_runtime.jsx("iframe", {
					className: "gg-frame",
					src: graphSrc(sid),
					title: "Git 图谱"
				})
			});
		}

		/** Required service: the slot registry. */
		const inject = ["slots"];

		/** Client plugin body: the "Git 图谱" conversation tab only. */
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "git-graph",
				order: 20,
				label: () => "Git 图谱"
			}, GitGraphView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
