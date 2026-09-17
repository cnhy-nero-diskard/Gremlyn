/**
 * First-party provider/model choices exposed by the Dashboard.
 *
 * Cline owns the model catalog, so the Cline and ClinePass entries are
 * refreshed from its featured-model feed when the console asks for it. The
 * bundled feed keeps the picker useful offline. OpenAI Codex is deliberately
 * kept as a separate provider: Cline uses bare Codex model ids there, while
 * Cline usage-billing models use provider-qualified ids.
 *
 * The three OpenCode entries are curated, static lists of ids from the
 * namespaces `opencode auth login` can authenticate. Two are OpenCode's own
 * hosted gateways: `opencode/<model>` is the pay-as-you-go Zen gateway every
 * installation can reach, and `opencode-go/<model>` is the OpenCode Go
 * subscription — a *separate* namespace with its own credential entry in
 * `auth.json` and its own model roster, not an alias of Zen's. The third,
 * `openai/<model>`, is not an OpenCode gateway at all: it is the operator's
 * own OpenAI account, which OpenCode logs into directly (its login menu
 * offers "OpenAI (ChatGPT Plus/Pro or API key)"), billed by OpenAI rather
 * than by OpenCode. All three land in the same seeded `auth.json`. They exist
 * purely to save typing for the common cases; picking "Custom provider" and
 * typing any `provider/model` OpenCode itself understands (per `opencode
 * models`) still works, per config.example.yaml.
 *
 * Every entry names the executor kinds (`AgentDefinition.kind`) it belongs
 * to: the Cline billing, ClinePass, and Codex entries serve Cline
 * repositories, while all three OpenCode namespaces serve OpenCode ones. The
 * console filters the picker by a repository's agent kind, so a card never
 * offers a provider its own executor could not authenticate against.
 *
 * Note that OpenAI is reachable under both executors by different routes, and
 * the two are not interchangeable: Cline's `openai-codex` entry is Cline's own
 * ChatGPT-subscription OAuth, driven by the Cline binary, while `openai` here
 * is OpenCode's direct login, driven by the OpenCode binary. Neither executor
 * can use the other's credential, which is why they are separate entries
 * bound to separate kinds rather than one shared "OpenAI" provider.
 */

export const CLINE_FEATURED_MODELS_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

/**
 * The OpenCode release whose `opencode models` output the three rosters below
 * were pasted from.
 *
 * Deliberately a second constant rather than a reference to
 * EXPECTED_OPENCODE_VERSION, and deliberately absent from `pin.ts`'s
 * `docPins`: an automated pin bump must not re-date this claim, because only a
 * human re-pasting the lists can make it true again. `pin:sync` carries the
 * pin across the patch releases OpenCode ships weekly, and that is exactly
 * when a roster goes stale unnoticed — `opencode-go/deepseek-flash` was
 * missing from the picker from the 1.18.30 bump until it was found by hand.
 * A test asserts the two constants agree, so a bump stays red until the
 * rosters are refreshed.
 *
 * Note that agreement is necessary, not sufficient: OpenCode serves these
 * rosters dynamically, so ids appear and disappear between releases too
 * (`opencode-go/omen-alpha` was withdrawn within an hour of this paste). That
 * is why the check is a human-owned marker rather than a test diffing the live
 * command, which would fail on OpenCode's schedule rather than on a change to
 * this repository.
 */
export const OPENCODE_ROSTER_VERSION = "1.18.31";

export interface ProviderModelOption {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  tier?: "recommended" | "free" | "subscribed";
}

export interface ProviderOption {
  id: string;
  /** Executor kinds (`AgentDefinition.kind`) whose repositories this entry serves. */
  kinds: readonly string[];
  name: string;
  description: string;
  auth: string;
  defaultModelId: string;
  models: ProviderModelOption[];
}

export interface ProviderCatalogSnapshot {
  source: "bundled" | "cline-api";
  updatedAt: string | null;
  providers: ProviderOption[];
}

/**
 * Return whether a known provider belongs to an executor kind. Unknown ids are
 * operator-supplied providers and remain usable because the catalog cannot
 * make claims about their authentication surface.
 */
export function providerSupportsAgentKind(
  catalog: ProviderCatalogSnapshot,
  providerId: string,
  kind: string,
): boolean {
  const provider = catalog.providers.find((entry) => entry.id === providerId);
  return provider === undefined || provider.kinds.includes(kind);
}

interface FeaturedModel {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
}

interface FeaturedFeed {
  recommended?: FeaturedModel[];
  free?: FeaturedModel[];
  clinePass?: FeaturedModel[];
}

const FALLBACK_FEED: Required<FeaturedFeed> = {
  recommended: [
    {
      id: "moonshotai/kimi-k3",
      name: "Kimi K3",
      description: "Moonshot AI's flagship model for agentic coding.",
      tags: ["NEW"],
    },
    {
      id: "anthropic/claude-opus-5",
      name: "Claude Opus 5",
      description: "Anthropic's latest frontier model.",
      tags: ["NEW"],
    },
    {
      id: "x-ai/grok-4.5",
      name: "Grok 4.5",
      description: "Frontier performance for coding.",
      tags: ["NEW"],
    },
    {
      id: "openai/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      description: "OpenAI's latest frontier coding model.",
      tags: ["NEW"],
    },
  ],
  free: [
    {
      id: "cline-free/longcat-2.0",
      name: "LongCat 2.0",
      description: "A next-generation model built for agentic coding.",
    },
    {
      id: "z-ai/glm-5.3-flash",
      name: "GLM 5.3 Flash",
      description: "A natively multimodal model in the GLM-5 series.",
    },
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      description: "Fast and efficient with a 1M context window.",
    },
    {
      id: "poolside/laguna-s-2.1:free",
      name: "Laguna S 2.1",
      description: "A coding-agent model from Poolside.",
    },
  ],
  clinePass: [
    {
      id: "cline-pass/glm-5.3-flash",
      name: "GLM 5.3 Flash",
      description: "A natively multimodal model in the GLM-5 series.",
    },
    {
      id: "cline-pass/kimi-k3",
      name: "Kimi K3",
      description: "A leading open-weights model for agentic coding.",
    },
    {
      id: "cline-pass/kimi-k2.6",
      name: "Kimi K2.6",
      description: "A strong multimodal model for long-horizon agent tasks.",
    },
    {
      id: "cline-pass/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      description: "Fast and efficient with a 1M context window.",
    },
    {
      id: "cline-pass/qwen3.8-max",
      name: "Qwen3.8 Max",
      description: "Qwen's latest coding model.",
    },
    {
      id: "cline-pass/qwen3.7-plus",
      name: "Qwen3.7 Plus",
      description: "A fast multimodal agent model.",
    },
    {
      id: "cline-pass/minimax-m3",
      name: "MiniMax M3",
      description: "A frontier coding and agent model with a 1M context window.",
    },
    {
      id: "cline-pass/kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      description: "A model specialized for agentic coding.",
    },
    {
      id: "cline-pass/glm-5.3",
      name: "GLM 5.3",
      description: "A top open-weights model from Z.AI.",
    },
    {
      id: "cline-pass/glm-5.2",
      name: "GLM 5.2",
      description: "A top open-weights model.",
    },
    {
      id: "cline-pass/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      description: "Frontier reasoning and coding with a 1M context window.",
    },
    {
      id: "cline-pass/qwen3.7-max",
      name: "Qwen3.7 Max",
      description: "A flagship agent model.",
    },
    {
      id: "cline-pass/mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      description: "An open model for long autonomous coding runs.",
    },
    {
      id: "cline-pass/mimo-v2.5",
      name: "MiMo V2.5",
      description: "Fast and efficient for everyday coding.",
    },
  ],
};

/**
 * The `opencode/<model>` ids OpenCode's pay-as-you-go Zen gateway serves,
 * verbatim from `opencode models` on the pinned 1.18.31 (see
 * EXPECTED_OPENCODE_VERSION). OpenCode also accepts other configured
 * providers folded into the same `-m` argument (e.g.
 * `anthropic/claude-opus-5`), but those depend on each installation's own
 * `opencode auth login` state, so only the namespaces OpenCode's own login
 * menu offers are enumerated here (see OPENCODE_GO_MODEL_IDS and
 * OPENCODE_OPENAI_MODEL_IDS for the others); the "Custom provider" path
 * (config.example.yaml) remains the way to target anything else.
 *
 * Kept as bare ids rather than hand-written entries: names come from the same
 * `modelName` humanization the live Cline feed gets, so a version bump is a
 * paste of the command's output rather than 60-odd descriptions to invent.
 */
const OPENCODE_ZEN_MODEL_IDS: readonly string[] = [
  "opencode/big-pickle",
  "opencode/claude-fable-5",
  "opencode/claude-fable-5-1",
  "opencode/claude-haiku-4-5",
  "opencode/claude-opus-4-5",
  "opencode/claude-opus-4-6",
  "opencode/claude-opus-4-7",
  "opencode/claude-opus-4-8",
  "opencode/claude-opus-5",
  "opencode/claude-sonnet-4",
  "opencode/claude-sonnet-4-5",
  "opencode/claude-sonnet-4-6",
  "opencode/claude-sonnet-5",
  "opencode/deepseek-v4-flash",
  "opencode/deepseek-v4-flash-vision-exp",
  "opencode/deepseek-v4-pro",
  "opencode/gemini-3-flash",
  "opencode/gemini-3.1-pro",
  "opencode/gemini-3.5-flash",
  "opencode/gemini-3.5-flash-lite",
  "opencode/gemini-3.6-flash",
  "opencode/gemini-3.7-flash",
  "opencode/gemini-3.8-flash",
  "opencode/glm-5",
  "opencode/glm-5.1",
  "opencode/glm-5.2",
  "opencode/glm-5.3",
  "opencode/glm-5.3-flash",
  "opencode/gpt-5",
  "opencode/gpt-5-codex",
  "opencode/gpt-5-nano",
  "opencode/gpt-5.1",
  "opencode/gpt-5.1-codex",
  "opencode/gpt-5.1-codex-max",
  "opencode/gpt-5.1-codex-mini",
  "opencode/gpt-5.2",
  "opencode/gpt-5.2-codex",
  "opencode/gpt-5.3-codex",
  "opencode/gpt-5.3-codex-spark",
  "opencode/gpt-5.4",
  "opencode/gpt-5.4-mini",
  "opencode/gpt-5.4-nano",
  "opencode/gpt-5.4-pro",
  "opencode/gpt-5.5",
  "opencode/gpt-5.5-pro",
  "opencode/gpt-5.6-luna",
  "opencode/gpt-5.6-sol",
  "opencode/gpt-5.6-terra",
  "opencode/gpt-6-astra",
  "opencode/grok-4.5",
  "opencode/grok-4.6",
  "opencode/grok-build-0.1",
  "opencode/kimi-k2.5",
  "opencode/kimi-k2.6",
  "opencode/kimi-k2.7-code",
  "opencode/kimi-k3",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/mimo-v2.5-free",
  "opencode/minimax-m2.5",
  "opencode/minimax-m2.7",
  "opencode/minimax-m3",
  "opencode/muse-spark-1.2",
  "opencode/muse-spark-1.2-contributor-free",
  "opencode/muse-spark-1.3",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/qwen3.5-plus",
  "opencode/qwen3.6-plus",
  "opencode/union-alpha",
];

/**
 * The `opencode-go/<model>` ids the OpenCode Go subscription serves, verbatim
 * from `opencode models` on the pinned 1.18.31.
 *
 * Go is its own provider, not a billing mode of Zen: `auth.json` carries a
 * distinct `opencode-go` credential beside the `opencode` one, and the two
 * rosters only partly overlap (Go alone serves longcat-2.0, the hy*
 * and qwen3.7/3.8 tiers; Zen alone serves the Anthropic and most GPT tiers).
 * Enumerating only Zen therefore left every Go model unreachable from the
 * picker, even though the executor passes `-m` through verbatim and the
 * seeded `auth.json` already authenticates both.
 */
const OPENCODE_GO_MODEL_IDS: readonly string[] = [
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-flash-vision-exp",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/glm-5.3",
  "opencode-go/glm-5.3-flash",
  "opencode-go/gpt-5.6-luna",
  "opencode-go/grok-4.6",
  "opencode-go/hy3",
  "opencode-go/hy4-preview",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k3",
  "opencode-go/longcat-2.0",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/muse-spark-1.2-contributor",
  "opencode-go/muse-spark-1.3-contributor",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "opencode-go/qwen3.8-flash",
  "opencode-go/qwen3.8-max",
  "opencode-go/union-alpha",
];

/**
 * The `openai/<model>` ids OpenCode serves from the operator's own OpenAI
 * account, verbatim from `opencode models` on the pinned 1.18.31.
 *
 * Unlike Zen and Go, this namespace is not an OpenCode gateway: OpenCode logs
 * into OpenAI directly ("OpenAI (ChatGPT Plus/Pro or API key)" in its login
 * menu) and the models bill to whichever of those the operator authenticated.
 * Because one namespace covers both auth modes, no tier badge is derived here
 * — marking these "subscribed" the way Go's roster is would misdescribe an
 * API-key installation, and OpenCode reports nothing that distinguishes the
 * two. The `-fast` ids are OpenAI's own priority-processing variants and are
 * listed as the CLI reports them rather than folded into their base model.
 */
const OPENCODE_OPENAI_MODEL_IDS: readonly string[] = [
  "openai/gpt-5.3-codex-spark",
  "openai/gpt-5.4",
  "openai/gpt-5.4-fast",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-mini-fast",
  "openai/gpt-5.5",
  "openai/gpt-5.5-fast",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-fast",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-fast",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-fast",
  "openai/gpt-6-astra",
  "openai/gpt-6-astra-fast",
];

/**
 * OpenCode exposes no per-model descriptions over the CLI, so the badge is the
 * one thing worth deriving: the `-free` suffix is Zen's own no-cost marker and
 * is what an operator actually scans that list for. Go's roster carries no
 * such suffix — every model on it is covered by the subscription — so its
 * entries take a uniform tier via `includedTier` instead.
 */
function opencodeModels(
  ids: readonly string[],
  includedTier?: NonNullable<ProviderModelOption["tier"]>,
): ProviderModelOption[] {
  return ids.map((id) => {
    const tier = id.endsWith("-free") ? ("free" as const) : includedTier;
    return {
      id,
      name: modelName(id),
      ...(tier === undefined ? {} : { tier }),
    };
  });
}

const CODEX_MODELS: ProviderModelOption[] = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description: "Flagship GPT-5.6 tier for the hardest coding and reasoning work.",
    tags: ["FLAGSHIP"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    description: "Balanced GPT-5.6 tier for cost, latency, and quality.",
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    description: "High-throughput GPT-5.6 tier for simpler or latency-sensitive work.",
  },
  {
    id: "gpt-5.6",
    name: "GPT-5.6",
    description: "The latest GPT-5.6 alias; routes to Sol.",
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    description: "Previous-generation text and reasoning model.",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Previous-generation default text and reasoning model.",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "Lower-cost model for lighter workflows and testing.",
  },
];

function mergeFeaturedModels(
  groups: readonly (readonly [FeaturedModel[], NonNullable<ProviderModelOption["tier"]>])[],
): ProviderModelOption[] {
  const models = new Map<string, ProviderModelOption>();
  for (const [entries, tier] of groups) {
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || entry.id.trim().length === 0) continue;
      const id = entry.id.trim();
      if (models.has(id)) continue;
      models.set(id, {
        id,
        name: entry.name?.trim() || modelName(id),
        ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
        ...(entry.tags?.length ? { tags: [...entry.tags] } : {}),
        tier,
      });
    }
  }
  return [...models.values()];
}

function modelName(id: string): string {
  const slug = id.split("/").at(-1) ?? id;
  return (
    slug
      // OpenCode carries Anthropic's dashed version suffixes (claude-haiku-4-5),
      // where the separator is a decimal point rather than a word break; Cline's
      // ids already dot theirs, so this only rescues the former from "Haiku 4 5".
      .replace(/(?<=\d)-(?=\d)/gu, ".")
      .replace(/[-_]+/gu, " ")
      .replace(/\b\w/gu, (letter) => letter.toUpperCase())
      .replace(/\bGpt\b/gu, "GPT")
      .replace(/\bAi\b/gu, "AI")
      .replace(/\bGlm\b/gu, "GLM")
  );
}

function provider(
  id: string,
  kinds: readonly string[],
  name: string,
  description: string,
  auth: string,
  defaultModelId: string,
  models: ProviderModelOption[],
): ProviderOption {
  const allModels = models.some((model) => model.id === defaultModelId)
    ? models
    : [
        ...models,
        {
          id: defaultModelId,
          name: modelName(defaultModelId),
          tags: ["DEFAULT"],
        },
      ];
  return { id, kinds, name, description, auth, defaultModelId, models: allModels };
}

function makeCatalog(
  feed: FeaturedFeed,
  source: ProviderCatalogSnapshot["source"],
  updatedAt: string | null,
): ProviderCatalogSnapshot {
  const recommended = Array.isArray(feed.recommended) ? feed.recommended : [];
  const free = Array.isArray(feed.free) ? feed.free : [];
  const clinePass = Array.isArray(feed.clinePass) ? feed.clinePass : [];
  return {
    source,
    updatedAt,
    providers: [
      provider(
        "cline",
        ["cline"],
        "Cline",
        "Cline usage-billing with featured and free models.",
        "Sign in with Cline",
        "moonshotai/kimi-k3",
        mergeFeaturedModels([
          [recommended, "recommended"],
          [free, "free"],
        ]),
      ),
      provider(
        "cline-pass",
        ["cline"],
        "ClinePass",
        "ClinePass subscription models with higher usage limits.",
        "Sign in with ClinePass",
        "cline-pass/kimi-k3",
        mergeFeaturedModels([[clinePass, "subscribed"]]),
      ),
      provider(
        "openai-codex",
        ["cline"],
        "OpenAI Codex",
        "ChatGPT subscription access through Cline's OpenAI Codex provider.",
        "Sign in with ChatGPT Subscription",
        "gpt-5.6-sol",
        CODEX_MODELS.map((model) => ({ ...model })),
      ),
      provider(
        "opencode",
        ["opencode"],
        "OpenCode Zen",
        "OpenCode's pay-as-you-go Zen gateway models, folded into the model id.",
        "opencode auth login",
        "opencode/claude-sonnet-5",
        opencodeModels(OPENCODE_ZEN_MODEL_IDS),
      ),
      provider(
        "opencode-go",
        ["opencode"],
        "OpenCode Go",
        "OpenCode Go subscription models, folded into the model id.",
        "opencode auth login (Go plan)",
        "opencode-go/kimi-k3",
        opencodeModels(OPENCODE_GO_MODEL_IDS, "subscribed"),
      ),
      provider(
        "openai",
        ["opencode"],
        "OpenAI",
        "Your own OpenAI account through OpenCode, folded into the model id.",
        "opencode auth login (ChatGPT Plus/Pro or API key)",
        "openai/gpt-5.6-sol",
        opencodeModels(OPENCODE_OPENAI_MODEL_IDS),
      ),
    ],
  };
}

export function bundledProviderCatalog(): ProviderCatalogSnapshot {
  return makeCatalog(FALLBACK_FEED, "bundled", null);
}

function parseFeaturedFeed(value: unknown): FeaturedFeed | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const feed = value as Record<string, unknown>;
  const parse = (key: string): FeaturedModel[] | undefined => {
    const entries = feed[key];
    if (!Array.isArray(entries)) return undefined;
    return entries.filter((entry): entry is FeaturedModel => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      return typeof (entry as { id?: unknown }).id === "string";
    });
  };
  const recommended = parse("recommended");
  const free = parse("free");
  const clinePass = parse("clinePass");
  if (!recommended && !free && !clinePass) return undefined;
  return {
    ...(recommended ? { recommended } : {}),
    ...(free ? { free } : {}),
    ...(clinePass ? { clinePass } : {}),
  };
}

export function catalogFromFeaturedFeed(
  value: unknown,
  updatedAt: string = new Date().toISOString(),
): ProviderCatalogSnapshot | undefined {
  const feed = parseFeaturedFeed(value);
  if (!feed) return undefined;
  return makeCatalog(feed, "cline-api", updatedAt);
}

export interface ProviderCatalogOptions {
  fetcher?: typeof fetch;
  refreshIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Cached live catalog with a bundled fallback for offline/locked-down hosts. */
export class ProviderCatalog {
  private current = bundledProviderCatalog();
  private lastAttemptAt = 0;
  private refreshPromise: Promise<ProviderCatalogSnapshot> | undefined;
  private readonly fetcher: typeof fetch;
  private readonly refreshIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: ProviderCatalogOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 5 * 60 * 1_000;
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.now = options.now ?? Date.now;
  }

  snapshot(): ProviderCatalogSnapshot {
    return this.current;
  }

  async refreshIfStale(force = false): Promise<ProviderCatalogSnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    if (
      !force &&
      this.lastAttemptAt > 0 &&
      this.now() - this.lastAttemptAt < this.refreshIntervalMs
    ) {
      return this.current;
    }
    this.lastAttemptAt = this.now();
    this.refreshPromise = this.fetchLive().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async fetchLive(): Promise<ProviderCatalogSnapshot> {
    try {
      const response = await this.fetcher(CLINE_FEATURED_MODELS_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`Cline model feed returned HTTP ${response.status}`);
      const live = catalogFromFeaturedFeed(
        await response.json(),
        new Date(this.now()).toISOString(),
      );
      if (live) this.current = live;
    } catch {
      // The fallback is intentional. A provider catalog must never prevent
      // the operator console from opening when the network is unavailable.
    }
    return this.current;
  }
}
