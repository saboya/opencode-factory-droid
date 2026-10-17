import { Model, Plugin, Provider } from "@opencode/plugin";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
type ListedModel = Awaited<ReturnType<Context["model"]["list"]>>["data"][number];

// OpenCode 2.0.32 Model.preferFree order when only its free models are available.
const PREFERRED_FREE = [
  "big-pickle", "deepseek-v4.1-flash-free", "glm-5.3-flash-free", "muse-spark-1.3-contributor-free",
];

export function selectFreeTitleModel(models: readonly ListedModel[]) {
  const free = models.filter((model) => model.providerID === "opencode" && model.enabled &&
    model.cost.length > 0 && model.cost.every((tier) =>
      tier.input === 0 && tier.output === 0 && (tier.cache?.read ?? 0) === 0 && (tier.cache?.write ?? 0) === 0) &&
    [model.capabilities.input, model.capabilities.output].every((types) =>
      types.length === 0 || types.some((type) => type.startsWith("text"))));
  return PREFERRED_FREE.map((id) => free.find((model) => model.id === id)).find(Boolean) ?? free[0];
}

export async function registerFreeTitles(ctx: Context) {
  const model = selectFreeTitleModel((await ctx.model.list()).data);
  // Do not silently fall back to a subscription model when free models vanish.
  if (!model) return ctx.session.hook("title", async (event) => {
    if (!(await ctx.agent.get({ agentID: "title" })).data.model) event.result = "";
  });
  return ctx.agent.transform((editor) => {
    editor.update("title", (agent) => {
      if (agent.model) return;
      agent.model = {
        providerID: Provider.ID.make("opencode"),
        id: Model.ID.make(model.id),
      };
    });
  });
}
