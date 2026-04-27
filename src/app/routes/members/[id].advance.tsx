// Story 5.2 — /members/:id/advance route host.
//
// Mirrors the [id].edit.tsx pattern: reads :id via useParams + delegates
// rendering to <AdvanceFlow>. Story 5.4 will wire the onConfirm prop;
// Story 5.2 leaves it omitted (CTA renders disabled).

import { Navigate, useParams } from "react-router-dom";

import { AdvanceFlow } from "@/features/transaction/ui/AdvanceFlow";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MemberAdvanceRoute() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  if (!UUID_REGEX.test(id)) {
    return <Navigate to="/members" replace />;
  }
  return <AdvanceFlow memberId={id} />;
}
