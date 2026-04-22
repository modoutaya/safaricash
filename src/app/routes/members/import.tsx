// Story 2.3 — /members/import: 3-step bulk-import state machine.
//
// State: "consent" → "picker" → "progress" → exit.
// On unsupported browsers (iOS / Firefox / desktop), short-circuits to a
// fallback screen that points the user back to manual entry.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  ConsentScreen,
  ContactsPickerStep,
  ImportProgressStep,
  grantContactsConsent,
  isContactPickerSupported,
  useImportMembers,
  type ImportRow,
  type PickedContact,
} from "@/features/member";
import { formatE164, isValidSenegalPhone } from "@/features/auth/ui/phoneFormat";
import { useT } from "@/i18n/useT";

type Step = "consent" | "picker" | "progress";

interface ContactsManagerSelectResult {
  name?: string[];
  tel?: string[];
}

function normalizeContact(raw: ContactsManagerSelectResult, fallbackId: string): PickedContact {
  const name = (raw.name?.[0] ?? "").trim();
  const rawPhone = raw.tel?.[0] ?? "";
  const candidate = formatE164(rawPhone);
  const phone = isValidSenegalPhone(candidate) ? candidate : "";
  return { id: fallbackId, name, phone };
}

function UnsupportedFallback() {
  const t = useT();
  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 text-center">
      <h1 className="text-display text-primary-700">{t("members.import.unsupported_title")}</h1>
      <p className="text-body-1 text-text-secondary">{t("members.import.unsupported_body")}</p>
      <Button asChild size="lg" className="w-full">
        <Link to="/members/new">{t("members.import.unsupported_cta_manual")}</Link>
      </Button>
    </section>
  );
}

export default function MembersImportRoute() {
  const navigate = useNavigate();
  const t = useT();
  const supported = isContactPickerSupported();
  const [step, setStep] = useState<Step>("consent");
  const [contacts, setContacts] = useState<PickedContact[]>([]);
  const importer = useImportMembers();
  // Avoid double-firing import.start under React StrictMode dev-double-mount.
  const startedRef = useRef(false);

  // Auto-navigate to /members on full success (the parent owns navigation,
  // not the progress component — same split as Story 2.2 LoginRoute).
  useEffect(() => {
    if (step !== "progress") return;
    if (importer.isRunning) return;
    if (importer.summary.total === 0) return;
    if (importer.summary.ok === importer.summary.total) {
      toast.success(t("members.import.summary_all_ok", { n: importer.summary.ok }));
      navigate("/members", { replace: true });
    }
  }, [step, importer.isRunning, importer.summary, navigate, t]);

  if (!supported) {
    return <UnsupportedFallback />;
  }

  async function handleConsentContinue(): Promise<void> {
    grantContactsConsent();
    try {
      // Pull the API surface dynamically so SSR / unsupported paths never
      // reference the unstable global.
      const nav = navigator as Navigator & {
        contacts?: {
          select: (
            props: string[],
            options?: { multiple?: boolean },
          ) => Promise<ContactsManagerSelectResult[]>;
        };
      };
      if (!nav.contacts?.select) return;
      const picked = await nav.contacts.select(["name", "tel"], { multiple: true });
      if (!picked || picked.length === 0) {
        // User cancelled the picker — stay on the consent screen.
        return;
      }
      setContacts(
        picked
          .map((p, i) => normalizeContact(p, `${Date.now()}-${i}`))
          .filter((c) => c.name !== ""),
      );
      setStep("picker");
    } catch (err) {
      // Common path: user dismisses the OS picker → some browsers throw,
      // some resolve with []. Either way, stay on consent.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[contacts] picker dismissed or failed", err);
      }
    }
  }

  function handleCancel(): void {
    navigate("/members");
  }

  function handlePickerConfirm(rows: ImportRow[]): void {
    setStep("progress");
    if (!startedRef.current) {
      startedRef.current = true;
      void importer.start(rows);
    }
  }

  if (step === "consent") {
    return <ConsentScreen onContinue={handleConsentContinue} onCancel={handleCancel} />;
  }
  if (step === "picker") {
    return (
      <ContactsPickerStep
        contacts={contacts}
        onConfirm={handlePickerConfirm}
        onCancel={handleCancel}
      />
    );
  }
  return (
    <ImportProgressStep
      contacts={contacts}
      results={importer.results}
      summary={importer.summary}
      isRunning={importer.isRunning}
      onRetryFailed={() => void importer.retryFailed()}
      onCancel={handleCancel}
    />
  );
}
