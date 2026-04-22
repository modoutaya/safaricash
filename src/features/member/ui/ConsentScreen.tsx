// Story 2.3 — Step 1 of 3: explicit consent before invoking the OS picker.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

export type ConsentScreenProps = {
  onContinue: () => void;
  onCancel: () => void;
};

export function ConsentScreen({ onContinue, onCancel }: ConsentScreenProps) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <section
      className="mx-auto flex w-full max-w-md flex-col gap-6 p-4"
      aria-labelledby="consent-title"
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 id="consent-title" className="text-display text-primary-700">
          {t("members.import.title")}
        </h1>
        <p className="text-body-1 text-text-secondary">{t("members.import.consent_body")}</p>
      </header>

      <div className="flex flex-col gap-2 rounded-lg border border-hairline bg-card p-4">
        <p className="text-body-2 font-medium text-text-primary">
          {t("members.import.consent_reads")}
        </p>
        <p className="text-body-2 text-text-secondary">
          {t("members.import.consent_does_not_read")}
        </p>
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.currentTarget.checked)}
          className="mt-1 h-5 w-5 cursor-pointer rounded border-text-tertiary text-primary-500 focus:ring-primary-500"
          aria-describedby="consent-checkbox-label"
        />
        <span id="consent-checkbox-label" className="text-body-2 text-text-primary">
          {t("members.import.consent_checkbox")}
        </span>
      </label>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          size="lg"
          disabled={!acknowledged}
          onClick={onContinue}
          className="w-full"
        >
          {t("members.import.cta_continue")}
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={onCancel} className="w-full">
          {t("members.import.cta_cancel")}
        </Button>
      </div>
    </section>
  );
}
