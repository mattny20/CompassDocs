import { getAiKeySource, getAiModel, DEFAULT_AI_MODEL } from "@/lib/ai-config";
import { embeddingsStatus } from "@/lib/embeddings";
import { AiSettings } from "@/components/AiSettings";
import { SemanticSearchPanel } from "@/components/SemanticSearchPanel";

export const dynamic = "force-dynamic";

export default async function AiPage() {
  const source = await getAiKeySource();
  return (
    <div className="space-y-6">
      <AiSettings
        initial={{
          source,
          has_key: source !== "none",
          model: await getAiModel(),
          default_model: DEFAULT_AI_MODEL,
        }}
      />
      <SemanticSearchPanel initial={await embeddingsStatus()} />
    </div>
  );
}
