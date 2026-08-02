import { requireSettingsSection } from "@/lib/auth";
import {
  getAiKeySource,
  getAiModel,
  DEFAULT_AI_MODEL,
  getAiProviderConfig,
  OPENAI_DEFAULT_URL,
} from "@/lib/ai-config";
import { embeddingsStatus } from "@/lib/embeddings";
import { AiSettings } from "@/components/AiSettings";
import { SemanticSearchPanel } from "@/components/SemanticSearchPanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function AiPage() {
  await requireSettingsSection("/admin/ai");
  const [source, providerCfg] = await Promise.all([getAiKeySource(), getAiProviderConfig()]);
  return (
    <SettingsPage href="/admin/ai">
    <div className="space-y-6">
      <AiSettings
        initial={{
          source,
          has_key: source !== "none",
          model: await getAiModel(),
          default_model: DEFAULT_AI_MODEL,
          provider: providerCfg.provider,
          openai_base_url: providerCfg.openaiBaseUrl,
          openai_key_set: providerCfg.openaiKeySet,
          openai_model: providerCfg.openaiModel,
          openai_default_url: OPENAI_DEFAULT_URL,
        }}
      />
      <SemanticSearchPanel initial={await embeddingsStatus()} />
    </div>
    </SettingsPage>
  );
}
