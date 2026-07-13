import { getAiKeySource, getAiModel, DEFAULT_AI_MODEL } from "@/lib/ai-config";
import { AiSettings } from "@/components/AiSettings";

export const dynamic = "force-dynamic";

export default async function AiPage() {
  const source = await getAiKeySource();
  return (
    <AiSettings
      initial={{
        source,
        has_key: source !== "none",
        model: await getAiModel(),
        default_model: DEFAULT_AI_MODEL,
      }}
    />
  );
}
