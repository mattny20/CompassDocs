"use client";

// The sign-in steps (1.16.0, STYLEGUIDE §Sign-in surfaces). One form whose
// parts appear and lock in place:
//
//   combined   no single sign-on: email or username and password together
//              (the community build; no lookup is ever made)
//   local      /login?local=1: the same, the break-glass when SSO is on
//   identify   email or username first; the server (/api/auth/lookup)
//              says where it signs in:
//                password → the password step under the locked identifier
//                one provider → "Redirecting to Microsoft", straight there
//                (after a ?sso_error it waits for a click instead)
//                two providers → a choice
//   totp / recovery   the second factor, when the account has one
//
// SSO never sits beside a password field: on a password step it is behind
// "Other ways to sign in". The identifier input stays mounted for the whole
// flow (the one autocomplete=username element), inputs are uncontrolled and
// read on submit, and the submit is disabled until hydration, so nothing a
// password manager filled is lost and nothing is sent by a plain form post.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { ChevronDown, CircleAlert, ExternalLink } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { Field, FormError, TextInput } from "@/components/form";
import { Spinner } from "@/components/Spinner";
import { AuthHeading } from "./AuthHeading";
import { IdentifierRow } from "./IdentifierRow";
import { ProviderMark, providerName } from "./ProviderMark";
import { realTransport, type SignInProviderLink, type SignInTransport } from "@/lib/sign-in-transport";
import { demoTransport } from "@/lib/sign-in-demo";
import { forgetIdentifier, readRememberedIdentifier, rememberIdentifier } from "@/lib/remembered-identifier";

export type SignInMode = "combined" | "local" | "identify";
type Step = "start" | "password" | "chosen" | "redirect" | "continue" | "choose" | "totp" | "recovery";
type Busy = null | "lookup" | "login";
type FocusTarget = "id" | "pw" | "code" | "status" | "continue" | "title" | null;

const OFFLINE = "You're offline. Check your connection and try again.";
const BAD_START = "Single sign-on isn't available right now. Try again, or ask your administrator.";
const DEFAULT_HELP = "Forgot your password? Ask your administrator to reset it.";

/** "mailto:x@y" and "Name <x@y>" (a pasted address) become "x@y"; everything is trimmed. */
export function normalizeIdentifier(raw: string): string {
  let v = raw.trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(v);
  if (angle) v = angle[1];
  if (/^mailto:/i.test(v)) v = v.slice(7);
  return v.trim();
}

const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function SignInFlow({
  mode,
  ssoOnly = false,
  next,
  company,
  providers,
  ssoError,
  help,
  example,
  demo = false,
}: {
  mode: SignInMode;
  ssoOnly?: boolean;
  next: string;
  company: string;
  /** The usable providers, with server-built starts (no login hint): "Other ways to sign in". */
  providers: SignInProviderLink[];
  /** The sentence for a ?sso_error the page arrived with. */
  ssoError?: string;
  /** The admin's help line and link. */
  help?: { text: string; url: string };
  /** The admin's example email, shown faintly in the empty identifier field. */
  example?: string;
  /** The admin preview: scripted answers, nothing sent. */
  demo?: boolean;
}) {
  const router = useRouter();
  const [signedInPreview, setSignedInPreview] = useState(false);
  const transport: SignInTransport = useMemo(
    () => (demo ? demoTransport(() => setSignedInPreview(true), { ssoOnly }) : realTransport(router)),
    [demo, ssoOnly, router]
  );

  const [hydrated, setHydrated] = useState(false);
  const [step, setStep] = useState<Step>("start");
  const [pwStep, setPwStep] = useState<Step>("start");
  const [identifier, setIdentifier] = useState("");
  const [chosen, setChosen] = useState<SignInProviderLink[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [spin, setSpin] = useState(false);
  const [late, setLate] = useState(false);
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [idError, setIdError] = useState("");
  const [pwError, setPwError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [formError, setFormError] = useState("");
  const [limited, setLimited] = useState(false);
  const [ssoHint, setSsoHint] = useState(false);
  const [remembered, setRemembered] = useState<string | null>(null);
  const [isRemembered, setIsRemembered] = useState(false);
  const [announce, setAnnounce] = useState("");

  const formRef = useRef<HTMLFormElement>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLAnchorElement>(null);
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const timers = useRef<number[]>([]);
  const focusNext = useRef<FocusTarget>(null);
  const [focusTick, setFocusTick] = useState(0);
  const hadSsoError = useRef(Boolean(ssoError));
  // The ?sso_error sentence, for the life of the page; typing does not dismiss it (bannerShown picks the steps).
  const banner = ssoError ?? "";

  const locked = step !== "start" && step !== "chosen";
  const twoFactor = step === "totp" || step === "recovery";
  const hasPassword = (step === "start" && mode !== "identify") || step === "password" || step === "chosen" || twoFactor;
  const passwordStep = hasPassword && !twoFactor;
  const anyProviders = providers.length > 0;

  const clearTimers = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };
  const goFocus = (t: FocusTarget) => {
    focusNext.current = t;
    setFocusTick((n) => n + 1);
  };
  /** Abandon what is in flight; its reply, if one still arrives, is ignored. */
  const cancelPending = () => {
    clearTimers();
    abort.current?.abort();
    inFlight.current = false;
    setBusy(null);
    setLate(false);
  };

  // Hydration, the remembered identifier and the ?sso_error clean-up, once.
  useEffect(() => {
    setHydrated(true);
    const r = readRememberedIdentifier();
    setRemembered(r);
    if (r && idRef.current && idRef.current.value === "") {
      idRef.current.value = r;
      setIsRemembered(true);
      if (document.activeElement === idRef.current) idRef.current.select();
    }
    if (ssoError) {
      // A reload must not show the banner again; next and local stay.
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("sso_error");
        window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      } catch {
        // the banner simply shows again on a reload
      }
    }
    return clearTimers;
  }, [ssoError]);

  // Back from the identity provider (the page restored from the back-forward
  // cache): start over at the first step with the identifier kept. Nothing
  // continues on its own.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      cancelPending();
      setSpin(false);
      setFormError("");
      setCodeError("");
      setPwError("");
      setIdError("");
      setSsoHint(false);
      setStep("start");
      goFocus("id");
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // The spinner only after 150ms of waiting, so a fast answer never flashes.
  useEffect(() => {
    if (!busy) {
      setSpin(false);
      return;
    }
    const t = window.setTimeout(() => {
      setSpin(true);
      if (busy === "lookup") setAnnounce("Checking how you sign in…");
    }, 150);
    return () => window.clearTimeout(t);
  }, [busy]);

  // Focus where the step says, after it renders.
  useEffect(() => {
    const t = focusNext.current;
    if (!t) return;
    focusNext.current = null;
    const el =
      t === "id" ? idRef.current : t === "pw" ? pwRef.current : t === "code" ? codeRef.current : t === "status" ? statusRef.current : t === "continue" ? continueRef.current : titleRef.current;
    el?.focus({ preventScroll: false });
    if (t === "id" && idRef.current) idRef.current.select();
  }, [focusTick]);

  // The preview never remembers what an admin types (it would prefill their real sign-in page).
  const keep = useCallback((id: string) => {
    if (!demo && id) rememberIdentifier(id);
  }, [demo]);
  // The locked identifier, or what is in the field while it is editable.
  const remember = useCallback(() => {
    keep(locked ? identifier : normalizeIdentifier(idRef.current?.value ?? ""));
  }, [identifier, keep, locked]);
  /** A provider link's click: remembered on a plain click; in the preview it goes nowhere. */
  const follow = useCallback(
    (e: React.MouseEvent) => {
      if (demo) {
        e.preventDefault();
        return;
      }
      if (plainClick(e)) remember();
    },
    [demo, remember]
  );

  function startProvider(p: SignInProviderLink, id: string) {
    if (!p.start.startsWith("/api/ee/")) {
      setFormError(BAD_START);
      setStep("start");
      goFocus("id");
      return;
    }
    if (hadSsoError.current) {
      setChosen([p]);
      setStep("continue");
      goFocus("continue");
      return;
    }
    keep(id);
    setChosen([p]);
    setStep("redirect");
    setAnnounce(statusText(p));
    goFocus("status");
    // One paint of the status first, then the hand-off.
    requestAnimationFrame(() => requestAnimationFrame(() => transport.navigate(p.start)));
    timers.current.push(window.setTimeout(() => setLate(true), 3000));
  }

  async function doLookup() {
    const id = normalizeIdentifier(idRef.current?.value ?? "");
    if (idRef.current) idRef.current.value = id;
    if (!id || id.length > 254) {
      setIdError("Enter your email or username.");
      goFocus("id");
      return;
    }
    setIdError("");
    inFlight.current = true;
    setBusy("lookup");
    const ac = new AbortController();
    abort.current = ac;
    let r;
    try {
      r = await transport.lookup(id, next, ac.signal);
    } catch {
      return; // aborted: Change or "Use a password instead" took over
    } finally {
      if (abort.current === ac) {
        inFlight.current = false;
        setBusy(null);
      }
    }
    if (ac.signal.aborted) return;
    setIdentifier(id);
    if (r.kind === "password") {
      setPwStep("password");
      setStep("password");
      setAnnounce(`Enter the password for ${id}.`);
      goFocus("pw");
    } else if (r.kind === "sso") {
      const list = r.providers.filter((p) => p.start.startsWith("/api/ee/"));
      if (list.length === 0) {
        setFormError(BAD_START);
        goFocus("id");
      } else if (list.length === 1) {
        startProvider(list[0], id);
      } else {
        // Remembered on a provider click (follow), not for showing the choice.
        setChosen(list);
        setStep("choose");
        goFocus("title");
      }
    } else if (r.kind === "field") {
      setIdError(r.error);
      goFocus("id");
    } else {
      setFormError(r.error);
      if (r.kind === "limited") setLimited(true);
      goFocus("id");
    }
  }

  async function doLogin() {
    const id = locked ? identifier : normalizeIdentifier(idRef.current?.value ?? "");
    if (!locked && idRef.current) idRef.current.value = id;
    const password = pwRef.current?.value ?? "";
    if (!locked && (!id || id.length > 254)) {
      setIdError("Enter your email or username.");
      goFocus("id");
      return;
    }
    if (!password) {
      setPwError("Enter your password.");
      goFocus("pw");
      return;
    }
    let code: string | undefined;
    if (twoFactor) {
      code = (codeRef.current?.value ?? "").trim();
      if (step === "totp") code = code.replace(/\s/g, "");
      if (!code) {
        setCodeError("Enter your code.");
        goFocus("code");
        return;
      }
    }
    setIdError("");
    setPwError("");
    setCodeError("");
    setSsoHint(false);
    // The field is a password field again before the browser decides whether to offer saving it.
    flushSync(() => setShow(false));
    inFlight.current = true;
    setBusy("login");
    const ac = new AbortController();
    abort.current = ac;
    let r;
    try {
      r = await transport.login({ username: id, password, ...(code ? { totp_code: code } : {}) }, ac.signal);
    } catch {
      if (abort.current === ac) {
        inFlight.current = false;
        setBusy(null);
      }
      return;
    }
    // Back, the code switch, Change or a restore from the back-forward cache took over.
    if (abort.current !== ac || ac.signal.aborted) return;
    if (r.kind === "ok") {
      keep(id);
      if (demo) {
        inFlight.current = false;
        setBusy(null);
      }
      // Busy stays on until the next page commits.
      transport.signedIn(r.mustChange ? (next === "/" ? "/account/password" : `/account/password?next=${encodeURIComponent(next)}`) : next);
      return;
    }
    inFlight.current = false;
    setBusy(null);
    if (r.kind === "totp") {
      if (!twoFactor) {
        setIdentifier(id);
        setPwStep(step);
        setStep("totp");
        setAnnounce("Enter the 6-digit code from your authenticator app.");
      }
      if (r.error) setFormError(r.error);
      if (codeRef.current) codeRef.current.value = "";
      goFocus("code");
      return;
    }
    setFormError(r.error);
    if (r.kind === "invalid") {
      if (twoFactor) {
        if (codeRef.current) codeRef.current.value = "";
        goFocus("code");
      } else {
        if (pwRef.current) pwRef.current.value = "";
        if (anyProviders) setSsoHint(true);
        goFocus("pw");
      }
    } else {
      goFocus(twoFactor ? "code" : "pw");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setFormError("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setFormError(OFFLINE);
      return;
    }
    if (step === "start" && mode === "identify") await doLookup();
    else if (hasPassword) await doLogin();
  }

  /** Back to the first step with the identifier kept and selected. */
  function change() {
    cancelPending();
    if (step === "redirect") window.stop();
    setFormError("");
    setCodeError("");
    setPwError("");
    setIdError("");
    setSsoHint(false);
    if (pwRef.current) pwRef.current.value = "";
    if (idRef.current && identifier) idRef.current.value = identifier;
    setStep("start");
    goFocus("id");
  }

  /** "Use a password instead": from the first step the identifier stays editable; from a hand-off it stays locked. */
  function usePassword() {
    cancelPending();
    setFormError("");
    if (step === "redirect" || step === "continue" || step === "choose") {
      if (step === "redirect") window.stop();
      setPwStep("password");
      setStep("password");
      setAnnounce(`Enter the password for ${identifier}.`);
      goFocus("pw");
      return;
    }
    setPwStep("chosen");
    setStep("chosen");
    setAnnounce("Password sign-in.");
    goFocus(idRef.current?.value ? "pw" : "id");
  }

  function back() {
    cancelPending();
    setFormError("");
    setCodeError("");
    setStep(pwStep);
    goFocus("pw");
  }

  function useAnotherAccount() {
    if (!demo) forgetIdentifier();
    setRemembered(null);
    setIsRemembered(false);
    if (idRef.current) idRef.current.value = "";
    goFocus("id");
  }

  const readCaps = (e: React.KeyboardEvent) => {
    const on = e.getModifierState?.("CapsLock") ?? false;
    if (on !== caps) {
      setCaps(on);
      if (on) setAnnounce("Caps Lock is on.");
    }
  };

  const enterToPassword = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !passwordStep || locked) return;
    if (e.currentTarget.value.trim() && pwRef.current && !pwRef.current.value) {
      e.preventDefault();
      pwRef.current.focus();
    }
  };

  // Headings and the one primary per step.
  const p0 = chosen[0];
  const vendor = p0 ? providerName(p0.mark) : null;
  let title = "Sign in";
  let subtitle: React.ReactNode = `to continue to ${company}`;
  if (step === "start" && mode === "local") {
    title = "Sign in with a password";
    subtitle = "For administrators and accounts that don't use single sign-on.";
  } else if (step === "chosen") title = "Sign in with a password";
  else if (step === "password") title = "Enter your password";
  else if (step === "redirect") title = vendor ? `Redirecting to ${vendor}` : "Redirecting to single sign-on";
  else if (step === "continue" && p0) title = p0.label;
  else if (step === "choose") {
    title = "Choose how to sign in";
    subtitle = "Your organization offers more than one way to sign in.";
  } else if (step === "totp") {
    title = "Two-factor authentication";
    subtitle = "Enter the 6-digit code from your authenticator app.";
  } else if (step === "recovery") {
    title = "Two-factor authentication";
    subtitle = "Enter one of the recovery codes you saved when you set up two-factor authentication.";
  }
  const submitLabel = step === "start" && mode === "identify" ? "Continue" : twoFactor ? "Verify" : hasPassword ? "Sign in" : null;

  let idHelp: React.ReactNode;
  if (step === "start" && isRemembered && remembered) {
    idHelp = (
      <>
        Not you?{" "}
        <button type="button" className="link font-medium" onClick={useAnotherAccount}>
          Use another account
        </button>
      </>
    );
  } else if (step === "start" && mode === "identify" && ssoOnly && providers.length === 1) {
    idHelp = `You'll continue to ${providerName(providers[0].mark) ?? "single sign-on"}.`;
  }

  const bannerShown = Boolean(banner) && (step === "start" || step === "chosen");
  const showOtherWays = anyProviders && ((passwordStep && step !== "start") || (step === "start" && mode === "local") || (step === "start" && mode === "identify" && limited));
  const footer: React.ReactNode[] = [];
  const passwordEscape = !ssoOnly && anyProviders;
  if (step === "start" && mode === "identify" && passwordEscape) {
    footer.push(
      <button key="pw" type="button" className="link text-sm font-medium" onClick={usePassword}>
        Use a password instead
      </button>
    );
  }
  if (step === "start" && mode === "local") {
    footer.push(
      <a key="sso" className="link text-sm font-medium" href={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`}>
        Use single sign-on instead
      </a>
    );
  }
  if ((step === "redirect" || step === "continue" || step === "choose") && !ssoOnly) {
    footer.push(
      <button key="pw" type="button" className="link text-sm font-medium" onClick={usePassword}>
        Use a password instead
      </button>
    );
  }
  if (twoFactor) {
    footer.push(
      <button
        key="switch"
        type="button"
        className="link text-sm font-medium"
        onClick={() => {
          cancelPending();
          setCodeError("");
          setFormError("");
          setStep(step === "totp" ? "recovery" : "totp");
          setAnnounce(step === "totp" ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app.");
          goFocus("code");
        }}
      >
        {step === "totp" ? "Use a recovery code" : "Use your authenticator app"}
      </button>,
      <button key="back" type="button" className="link text-sm font-medium" onClick={back}>
        Back
      </button>
    );
  }

  const helpText = help?.text || (passwordStep ? DEFAULT_HELP : "");
  const helpExternal = /^https:/i.test(help?.url ?? "");
  const helpLine = help?.url ? (
    <p className="mt-10 text-xs text-slate-500">
      <a
        className="link inline-flex items-center gap-1"
        href={help.url}
        {...(helpExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {help.text || "Get help signing in"}
        {helpExternal && <ExternalLink className="h-3 w-3" aria-hidden />}
      </a>
    </p>
  ) : helpText ? (
    <p className="mt-10 text-xs text-slate-500">{helpText}</p>
  ) : null;

  return (
    <>
      <AuthHeading ref={titleRef} title={title} subtitle={subtitle} />
      {demo && signedInPreview && (
        <p role="status" className="notice-ok mb-6 rounded-lg border px-3 py-2 text-sm">
          Signed in (preview).
        </p>
      )}
      {bannerShown && (
        <div id="sso-error" role="alert" className="notice-error mb-6 flex gap-2 rounded-lg border px-3 py-2 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{banner}</span>
        </div>
      )}
      <form
        ref={formRef}
        method="post"
        noValidate
        aria-labelledby="auth-title"
        aria-busy={busy ? true : undefined}
        onSubmit={onSubmit}
        className="space-y-4"
      >
        <Field
          label="Email or username"
          error={idError || undefined}
          help={idHelp}
          describedBy={bannerShown ? "sso-error" : undefined}
          className={locked ? "hidden" : ""}
        >
          <TextInput
            ref={idRef}
            type="text"
            name="username"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            maxLength={254}
            defaultValue=""
            readOnly={locked || busy === "lookup"}
            placeholder={example || undefined}
            autoFocus
            onKeyDown={enterToPassword}
            onInput={(e) => {
              setIsRemembered(Boolean(remembered) && e.currentTarget.value === remembered);
              if (idError) setIdError("");
            }}
            className="h-10 text-base sm:text-sm"
          />
        </Field>

        {locked && (
          <IdentifierRow
            label="Email or username"
            value={identifier}
            action={
              <button type="button" onClick={change} className={buttonClass("ghost", "sm")}>
                Change<span className="sr-only"> email or username</span>
              </button>
            }
          />
        )}

        {hasPassword && (
          <div className={twoFactor ? "hidden" : "transition-[opacity,translate] duration-200 ease-out starting:-translate-y-1 starting:opacity-0"}>
            <Field label="Password" error={pwError || undefined} help={caps ? "Caps Lock is on." : undefined}>
              <TextInput
                ref={pwRef}
                type={show ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                enterKeyHint="go"
                onKeyDown={readCaps}
                onKeyUp={readCaps}
                onBlur={() => setCaps(false)}
                onInput={() => pwError && setPwError("")}
                className="h-10 text-base sm:text-sm"
              />
            </Field>
            <label className="mt-2 inline-flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" className="h-4 w-4" checked={show} onChange={(e) => setShow(e.target.checked)} />
              Show password
            </label>
          </div>
        )}

        {twoFactor && (
          <div className="transition-[opacity,translate] duration-200 ease-out starting:-translate-y-1 starting:opacity-0">
            {step === "totp" ? (
              <Field key="totp" label="Two-factor code" error={codeError || undefined}>
                <TextInput
                  ref={codeRef}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  enterKeyHint="go"
                  maxLength={10}
                  onInput={() => codeError && setCodeError("")}
                  className="h-10 text-center font-mono text-lg tracking-[0.3em]"
                />
              </Field>
            ) : (
              <Field key="recovery" label="Recovery code" help="Each recovery code works once." error={codeError || undefined}>
                <TextInput
                  ref={codeRef}
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  maxLength={20}
                  onInput={() => codeError && setCodeError("")}
                  className="h-10 font-mono text-base tracking-wider sm:text-sm"
                />
              </Field>
            )}
          </div>
        )}

        {step === "redirect" && p0 && (
          <>
            <div
              ref={statusRef}
              role="status"
              tabIndex={-1}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface px-4 py-3 transition-[opacity,translate] duration-200 ease-out starting:-translate-y-1 starting:opacity-0"
            >
              <ProviderMark mark={p0.mark} className="h-5 w-5" />
              <p className="min-w-0 flex-1 text-sm font-medium text-slate-800">{statusText(p0)}</p>
              <Spinner />
            </div>
            {late && (
              <p className="text-sm text-slate-500">
                Not redirected?{" "}
                <a className="link font-medium" href={p0.start} onClick={follow}>
                  {p0.label}
                </a>
              </p>
            )}
          </>
        )}

        {step === "continue" && p0 && (
          <a ref={continueRef} href={p0.start} onClick={follow} className={buttonClass("primary", "lg", "w-full")}>
            Continue
          </a>
        )}

        {step === "choose" && (
          <ul className="space-y-2">
            {chosen.map((p) => (
              <li key={p.id}>
                <ProviderLink p={p} onFollow={follow} />
              </li>
            ))}
          </ul>
        )}

        <FormError>{formError}</FormError>

        {submitLabel && (
          <button
            type="submit"
            disabled={!hydrated}
            aria-disabled={busy ? true : undefined}
            aria-busy={busy ? true : undefined}
            className={buttonClass("primary", "lg", "w-full")}
          >
            {spin && <Spinner />}
            {submitLabel}
          </button>
        )}

        {ssoHint && passwordStep && showOtherWays && (
          <p className="text-xs text-slate-500">If your organization uses single sign-on, open Other ways to sign in below.</p>
        )}
      </form>

      {footer.length > 0 && <div className="mt-6 flex flex-col items-start gap-3">{footer}</div>}

      {showOtherWays && (
        <details open={limited || undefined} className="group mt-6 rounded-lg border border-slate-200 bg-surface text-left">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-slate-700">
            Other ways to sign in
            <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="space-y-2 border-t border-slate-100 p-3">
            {providers.map((p) => (
              <li key={p.id}>
                <ProviderLink p={p} onFollow={follow} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {helpLine}

      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </>
  );
}

function statusText(p: SignInProviderLink): string {
  const vendor = providerName(p.mark);
  return vendor ? `Taking you to ${vendor}…` : "Taking you to your organization's sign-in page…";
}

/** A provider's sign-in, always a plain link (a full navigation), never next/link. */
function ProviderLink({ p, onFollow }: { p: SignInProviderLink; onFollow: (e: React.MouseEvent) => void }) {
  return (
    <a href={p.start} onClick={onFollow} className={buttonClass("secondary", "lg", "w-full gap-2.5")}>
      <ProviderMark mark={p.mark} className="h-4 w-4" />
      <span className="min-w-0 truncate">{p.label}</span>
    </a>
  );
}
