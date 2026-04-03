import Anthropic from "@anthropic-ai/sdk";
import { getSignalConfig } from "@/signal.config";
import type { ScoredPost, ClassifiedPost, AiQuality, AiCategory, SelfPromoRisk } from "./types";
import { calculateDisplayScore } from "./scoring";

function getAiConfig() {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL; // unused for Anthropic SDK but reserved for future OpenAI compat
  const model = process.env.AI_MODEL || "claude-haiku-4-5-20251001";
  return { apiKey, baseUrl, model };
}

function buildSystemPrompt(): string {
  const config = getSignalConfig();
  const communityContext = config.communityContext || `Evaluate Reddit posts for quality and relevance.
Value actionable content with specific techniques, data, or insights.
Penalize low-effort posts, drama, and pure self-promotion.`;

  return `You are a content curator for a community feed.

${communityContext}

Evaluate each Reddit post across these dimensions:
- Actionability: Does it contain a specific technique, workflow, tip, or tool recommendation someone could use?
- Originality: Is this a novel insight, or common knowledge / repost?
- Depth: Is there substance, or is it low-effort?
- Relevance: Is it relevant to the community's interests?

Use the classify_post tool to return your assessment.

Quality calibration (aim for ~5% EXEMPLARY, ~15% HIGH, ~35% MEDIUM, ~45% LOW across a batch):
- EXEMPLARY = bookmark AND share with your team. Use sparingly — only for truly exceptional content.
- HIGH = bookmark-worthy. Solid guides, real comparisons, useful lessons with specific details.
- MEDIUM = worth a quick scan with at least one concrete takeaway.
- LOW = skip. Self-promotion without substance, low-effort posts, vague questions, rage-bait, off-topic.
- Boundary: interesting title with no substance → LOW. Genuine question with useful context → MEDIUM.

Self-promotion risk assessment:
- HIGH = post exists primarily to drive traffic to the author's product. Marketing language, no technical depth.
- MEDIUM = mentions own work but provides genuine value alongside it.
- LOW = no self-promotion detected.
IMPORTANT: A developer sharing what they built WITH real technical substance is a valuable SHOWCASE, not spam.

Summary style: Write as a smart friend. Be specific about what the reader gets. Never start with "This post" or "The author." Never be generic.`;
}

const FEW_SHOT_EXAMPLES: Anthropic.MessageParam[] = [
  {
    role: "user",
    content: `Title: I built a tool that saves you 10x time — try it free!
Subreddit: r/programming
Body: After weeks of frustration, I finally cracked the code. My new tool uses a proprietary algorithm to fix bugs 10x faster. Features: - One-click detection - Automatic fixes - Free tier available. Try it now at mytool.com
Upvotes: 45 | Comments: 12 | Ratio: 0.78`,
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "ex1",
        name: "classify_post",
        input: {
          reasoning: "Classic self-promotional post disguised as sharing. Marketing language throughout, feature list with no technical depth, and a direct product link.",
          quality: "LOW",
          category: "TOOL",
          summary: "Product pitch with no technical substance — just marketing copy and a signup link.",
          self_promo_risk: "HIGH",
        },
      },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "ex1", content: "OK" },
      { type: "text", text: `Title: I tracked my AI coding sessions for 3 weeks — here's what I learned about token usage
Subreddit: r/programming
Body: I've been tracking my usage across 47 sessions. The biggest surprise: 60% of my tokens go to context, not generation. Here's the breakdown by task type... [detailed stats, specific prompts that were token-heavy, how I restructured my workflow to cut costs by 40%]. The tracking tool is open source if anyone wants it.
Upvotes: 89 | Comments: 34 | Ratio: 0.94` },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "ex2",
        name: "classify_post",
        input: {
          reasoning: "Genuine build-in-public post with substantial technical depth. The real value is the token usage analysis and workflow optimization.",
          quality: "HIGH",
          category: "INSIGHT",
          summary: "Three weeks of AI coding token tracking reveals 60% goes to context — plus specific workflow changes that cut costs by 40%.",
          self_promo_risk: "MEDIUM",
        },
      },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "ex2", content: "OK" }],
  },
];

interface AiResult {
  reasoning: string;
  quality: AiQuality;
  category: AiCategory;
  summary: string;
  self_promo_risk: SelfPromoRisk;
}

const VALID_QUALITIES = new Set<AiQuality>(["EXEMPLARY", "HIGH", "MEDIUM", "LOW"]);
const VALID_CATEGORIES = new Set<AiCategory>([
  "TUTORIAL", "TOOL", "INSIGHT", "SHOWCASE", "DISCUSSION", "META",
]);
const VALID_SELF_PROMO_RISKS = new Set<SelfPromoRisk>(["HIGH", "MEDIUM", "LOW"]);

function normalizeQuality(value: unknown): AiQuality {
  const candidate = typeof value === "string" ? value.toUpperCase().trim() : "";
  return VALID_QUALITIES.has(candidate as AiQuality) ? (candidate as AiQuality) : "LOW";
}

function normalizeCategory(value: unknown): AiCategory {
  const candidate = typeof value === "string" ? value.toUpperCase().trim() : "";
  return VALID_CATEGORIES.has(candidate as AiCategory)
    ? (candidate as AiCategory)
    : "DISCUSSION";
}

function normalizeSelfPromoRisk(value: unknown): SelfPromoRisk {
  const candidate = typeof value === "string" ? value.toUpperCase().trim() : "";
  return VALID_SELF_PROMO_RISKS.has(candidate as SelfPromoRisk)
    ? (candidate as SelfPromoRisk)
    : "LOW";
}

export interface ClassificationBatchResult {
  classified: ClassifiedPost[];
  deferred: number;
  stoppedDueToRateLimit: boolean;
}

function buildUserMessage(post: ScoredPost): string {
  const body = post.body_snippet
    ? `\nBody: ${post.body_snippet}`
    : "";

  return `Title: ${post.title}
Subreddit: r/${post.subreddit}${body}
Upvotes: ${post.upvotes} | Comments: ${post.comment_count} | Ratio: ${post.upvote_ratio}`;
}

const CLASSIFICATION_TOOL: Anthropic.Tool = {
  name: "classify_post",
  description: "Classify a Reddit post for the curated feed",
  input_schema: {
    type: "object" as const,
    properties: {
      reasoning: { type: "string", description: "1-2 sentences on why this is or isn't worth reading" },
      quality: { type: "string", enum: ["EXEMPLARY", "HIGH", "MEDIUM", "LOW"] },
      category: { type: "string", enum: ["TUTORIAL", "TOOL", "INSIGHT", "SHOWCASE", "DISCUSSION", "META"] },
      summary: { type: "string", description: "One sentence: what a reader gets from this" },
      self_promo_risk: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
    },
    required: ["reasoning", "quality", "category", "summary", "self_promo_risk"],
  },
};

function extractToolResult(response: Anthropic.Message): AiResult | null {
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) return null;

  const input = toolUse.input as Record<string, string>;
  return {
    reasoning: (input.reasoning ?? "").slice(0, 500),
    quality: normalizeQuality(input.quality),
    category: normalizeCategory(input.category),
    summary: (input.summary ?? "").slice(0, 300),
    self_promo_risk: normalizeSelfPromoRisk(input.self_promo_risk),
  };
}

/**
 * Score a batch of posts using AI.
 * Currently uses the Anthropic SDK. Processes sequentially to respect rate limits.
 */
export async function classifyPosts(
  posts: ScoredPost[]
): Promise<ClassificationBatchResult> {
  const { apiKey, model } = getAiConfig();
  if (!apiKey) {
    console.info("signal: No AI_API_KEY set, skipping AI scoring (engagement-only ranking)");
    return {
      classified: posts.map((post) => ({
        ...post,
        ai_quality: "MEDIUM" as AiQuality,
        ai_category: "DISCUSSION" as AiCategory,
        ai_summary: "",
        ai_reasoning: "AI scoring not configured",
        self_promo_risk: "LOW" as SelfPromoRisk,
        display_score: calculateDisplayScore(post.engagement_score, "MEDIUM"),
        scored_at: new Date().toISOString(),
      })),
      deferred: 0,
      stoppedDueToRateLimit: false,
    };
  }

  const client = new Anthropic({ apiKey });
  const results: ClassifiedPost[] = [];
  let deferred = 0;
  let stoppedDueToRateLimit = false;

  for (let index = 0; index < posts.length; index++) {
    const post = posts[index];
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 300,
        temperature: 0.2,
        system: buildSystemPrompt(),
        tools: [CLASSIFICATION_TOOL],
        tool_choice: { type: "tool" as const, name: "classify_post" },
        messages: [
          ...FEW_SHOT_EXAMPLES,
          { role: "user", content: buildUserMessage(post) },
        ],
      });

      const parsed = extractToolResult(response);

      if (parsed) {
        results.push({
          ...post,
          ai_quality: parsed.quality,
          ai_category: parsed.category,
          ai_summary: parsed.summary,
          ai_reasoning: parsed.reasoning,
          self_promo_risk: parsed.self_promo_risk,
          display_score: calculateDisplayScore(
            post.engagement_score,
            parsed.quality,
            parsed.self_promo_risk
          ),
          scored_at: new Date().toISOString(),
        });
      } else {
        results.push({
          ...post,
          ai_quality: "LOW",
          ai_category: "DISCUSSION",
          ai_summary: "",
          ai_reasoning: "Tool use extraction failed",
          self_promo_risk: "LOW",
          display_score: 0,
          scored_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      const status = typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status?: unknown }).status)
        : undefined;

      if (status === 429) {
        deferred = posts.length - index;
        stoppedDueToRateLimit = true;
        console.warn(
          `signal: AI rate limit hit while scoring ${post.reddit_post_id}; deferring ${deferred} posts`
        );
        break;
      }

      console.error(`signal: AI scoring failed for ${post.reddit_post_id}:`, err);
      results.push({
        ...post,
        ai_quality: "LOW",
        ai_category: "DISCUSSION",
        ai_summary: "",
        ai_reasoning: `API error: ${err instanceof Error ? err.message : "unknown"}`,
        self_promo_risk: "LOW",
        display_score: 0,
        scored_at: new Date().toISOString(),
      });
    }
  }

  const exemplaryCount = results.filter((r) => r.ai_quality === "EXEMPLARY").length;
  const highCount = results.filter((r) => r.ai_quality === "HIGH").length;
  const lowCount = results.filter((r) => r.ai_quality === "LOW").length;
  const mediumCount = results.length - exemplaryCount - highCount - lowCount;
  const highPromo = results.filter((r) => r.self_promo_risk === "HIGH").length;
  console.info(
    `signal: AI scored ${results.length} posts — ${exemplaryCount} EXEMPLARY, ${highCount} HIGH, ${mediumCount} MEDIUM, ${lowCount} LOW | ${highPromo} flagged as high self-promo`
  );

  return { classified: results, deferred, stoppedDueToRateLimit };
}
