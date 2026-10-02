"use client";

import { useState } from "react";
import { PASSWORD_HELP, passwordProblem } from "@/lib/password-policy";
import { buttonClass } from "@/components/Button";
import { Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import { useRouter } from "next/navigation";
import type { SecureCookieMode, TlsMode } from "@/lib/settings";

const optional = <span className="font-normal text-slate-500">(optional)</span>;

export function SetupForm({
  enterprise = false,
  proxyManaged = false,
}: {
  enterprise?: boolean;
  proxyManaged?: boolean;
}) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [secureCookies, setSecureCookies] = useState<SecureCookieMode>("auto");
  const [licenseKey, setLicenseKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [domain, setDomain] = useState("");
  const [tlsMode, setTlsMode] = useState<TlsMode>("auto");
  const [tlsEmail, setTlsEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const pwProblem = passwordProblem(password);
    if (pwProblem) {
      setError(pwProblem);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          name,
          email,
          password,
          company_name: companyName,
          secure_cookies: secureCookies,
          ...(enterprise && licenseKey.trim() ? { license_key: licenseKey.trim() } : {}),
          ...(anthropicKey.trim() ? { anthropic_api_key: anthropicKey.trim() } : {}),
          ...(proxyManaged
            ? { custom_domain: domain.trim(), tls_mode: tlsMode, tls_email: tlsEmail.trim() }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Setup failed.");
      router.push("/");
      router.refresh();
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormError>{error}</FormError>

      <Field label={<>Company / workspace name {optional}</>}>
        <TextInput
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          autoFocus
          placeholder="CompassDocs"
          maxLength={80}
        />
      </Field>

      <div className="border-t border-slate-100 pt-4">
        <p className="mb-3 text-sm font-medium text-slate-700">Your admin account</p>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                placeholder="Jane Doe"
              />
            </Field>
            <Field label="Username">
              <TextInput
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="jane"
              />
            </Field>
          </div>
          <Field label={<>Email {optional}</>}>
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="jane@company.com"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Password" error={password && passwordProblem(password) ? PASSWORD_HELP : undefined}>
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={PASSWORD_HELP}
              />
            </Field>
            <Field label="Confirm password" error={confirm && confirm !== password ? "Passwords don't match." : undefined}>
              <TextInput
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <Field
          label={<>Anthropic API key {optional}</>}
          help="Enables AI answers and proofreading. Search works without it — you can also add or change the key later under Settings → AI."
        >
          <TextInput
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            autoComplete="off"
            placeholder="sk-ant-…"
            spellCheck={false}
          />
        </Field>
      </div>

      {enterprise && (
        <div className="border-t border-slate-100 pt-4">
          <Field label={<>Enterprise license key {optional}</>}>
            <Textarea
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder="Paste your license key to activate Enterprise features now — or add it later under Settings → License."
              className="h-20 font-mono text-xs"
              spellCheck={false}
            />
          </Field>
        </div>
      )}

      {proxyManaged && (
        <div className="border-t border-slate-100 pt-4">
          <p className="mb-1 text-sm font-medium text-slate-700">Domain &amp; HTTPS (optional)</p>
          <p className="mb-3 text-xs text-slate-500">
            Point a DNS record at this server, then set it up here. You can also do this later
            under Settings → Domain &amp; HTTPS.
          </p>
          <div className="space-y-3">
            <Field label="Domain">
              <TextInput
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="docs.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            {domain.trim() && (
              <>
                <Field
                  label="HTTPS"
                  help={
                    <>
                      Automatic HTTPS needs a <strong>public</strong> domain resolving to this
                      server with ports 80/443 reachable. Use self-signed for internal/LAN domains.
                    </>
                  }
                >
                  <Select value={tlsMode} onChange={(e) => setTlsMode(e.target.value as TlsMode)}>
                    <option value="auto">Automatic HTTPS — Let&rsquo;s Encrypt (public DNS)</option>
                    <option value="internal">Self-signed — internal CA (LAN / internal DNS)</option>
                    <option value="off">Plain HTTP (TLS handled elsewhere)</option>
                  </Select>
                </Field>
                {tlsMode === "auto" && (
                  <Field label={<>Contact email {optional}</>} help="For certificate renewal notices.">
                    <TextInput
                      type="email"
                      value={tlsEmail}
                      onChange={(e) => setTlsEmail(e.target.value)}
                      placeholder="admin@example.com"
                    />
                  </Field>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!proxyManaged && (
        <div className="border-t border-slate-100 pt-4">
          <Field
            label="How will you reach this server?"
            help={
              <>
                Controls the login cookie&rsquo;s <code className="font-mono">Secure</code> flag.
                Leave on Automatic unless you&rsquo;re sure — you can change it later under
                Settings → Domain &amp; HTTPS.
              </>
            }
          >
            <Select
              value={secureCookies}
              onChange={(e) => setSecureCookies(e.target.value as SecureCookieMode)}
            >
              <option value="auto">Automatic — detect HTTP vs HTTPS (recommended)</option>
              <option value="always">Always over HTTPS (I have a certificate)</option>
              <option value="never">Plain HTTP only (internal / no HTTPS)</option>
            </Select>
          </Field>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className={buttonClass("primary", "md", "w-full")}
      >
        {loading ? "Creating…" : "Create account & get started"}
      </button>
    </form>
  );
}
