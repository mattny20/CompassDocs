import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getAppSettings } from "@/lib/settings-store";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// Outlook add-in manifest, generated for THIS install: every URL points at the
// workspace's own origin, so the task pane is same-origin with the API and the
// user's session just works. Admins download it here (Settings → Workspace)
// and upload it in the Microsoft 365 admin center (Integrated apps) or via
// Outlook → Get add-ins → My add-ins → Add a custom add-in.

/** Deterministic UUID from the origin, so re-downloads keep the same add-in
 * identity (uploading again UPDATES instead of duplicating). */
function stableGuid(origin: string): string {
  const h = createHash("sha256").update("compassdocs-outlook:" + origin).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    // Version/variant nibbles forced so it's a well-formed v4-shaped UUID.
    "4" + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const origin = requestOrigin(req);
  const settings = await getAppSettings();
  const org = esc(settings.company_name);
  const host = esc(new URL(origin).host);
  const id = stableGuid(origin);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0"
           xsi:type="MailApp">
  <Id>${id}</Id>
  <Version>1.0.0</Version>
  <ProviderName>CompassDocs</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="${org} Docs"/>
  <Description DefaultValue="Search ${org}'s knowledge base, get AI answers, and insert document links without leaving Outlook."/>
  <IconUrl DefaultValue="${origin}/addin/icon-64.png"/>
  <HighResolutionIconUrl DefaultValue="${origin}/addin/icon-128.png"/>
  <SupportUrl DefaultValue="https://docs.compassdocs.io/guides/outlook-addin/"/>
  <AppDomains>
    <AppDomain>${origin}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.3"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings>
        <SourceLocation DefaultValue="${origin}/addin/outlook"/>
        <RequestedHeight>450</RequestedHeight>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  <DisableEntityHighlighting>false</DisableEntityHighlighting>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements>
      <bt:Sets DefaultMinVersion="1.3">
        <bt:Set Name="Mailbox"/>
      </bt:Sets>
    </Requirements>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="MessageReadCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="cdReadGroup">
                <Label resid="groupLabel"/>
                <Control xsi:type="Button" id="cdReadOpen">
                  <Label resid="openLabel"/>
                  <Supertip>
                    <Title resid="openLabel"/>
                    <Description resid="openTip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="icon16"/>
                    <bt:Image size="32" resid="icon32"/>
                    <bt:Image size="80" resid="icon80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <SourceLocation resid="paneUrl"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
          <ExtensionPoint xsi:type="MessageComposeCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="cdComposeGroup">
                <Label resid="groupLabel"/>
                <Control xsi:type="Button" id="cdComposeOpen">
                  <Label resid="openLabel"/>
                  <Supertip>
                    <Title resid="openLabel"/>
                    <Description resid="openTip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="icon16"/>
                    <bt:Image size="32" resid="icon32"/>
                    <bt:Image size="80" resid="icon80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <SourceLocation resid="paneUrl"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="icon16" DefaultValue="${origin}/addin/icon-16.png"/>
        <bt:Image id="icon32" DefaultValue="${origin}/addin/icon-32.png"/>
        <bt:Image id="icon80" DefaultValue="${origin}/addin/icon-80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="paneUrl" DefaultValue="${origin}/addin/outlook"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="groupLabel" DefaultValue="${org} Docs"/>
        <bt:String id="openLabel" DefaultValue="Open ${org} Docs"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="openTip" DefaultValue="Search ${host}, get AI answers, and insert document links into your email."/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="compassdocs-outlook-manifest.xml"',
    },
  });
}
