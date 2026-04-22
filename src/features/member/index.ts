// Story 2.1 — public barrel for the member feature.
// Downstream stories (2.2 create, 2.5 edit, 4.x transactions, 9.x dashboard)
// consume this barrel; direct imports into features/member/api/ or
// features/member/ui/ are forbidden by the `import/no-internal-modules`
// ESLint rule.

export { useMembers } from "./api/useMembers";
export { useCreateMember } from "./api/useCreateMember";
export { useImportMembers } from "./api/useImportMembers";
export { isContactPickerSupported } from "./api/contactsPickerSupport";
export {
  hasContactsConsent,
  grantContactsConsent,
  revokeContactsConsent,
} from "./api/contactsConsent";
export { MEMBERS_QUERY_KEY, MEMBER_HEADER_CTA_THRESHOLD, createMemberInputSchema } from "./types";
export { MemberList } from "./ui/MemberList";
export { MemberCard } from "./ui/MemberCard";
export { MemberForm } from "./ui/MemberForm";
export { ConsentScreen } from "./ui/ConsentScreen";
export { ContactsPickerStep, type PickedContact } from "./ui/ContactsPickerStep";
export { ImportProgressStep } from "./ui/ImportProgressStep";
export type {
  CreateMemberInput,
  DisplayStatus,
  DerivedStatus,
  MemberRow,
  MemberStatus,
  MemberWithMeta,
  CycleRow,
  CycleStatus,
  TransactionTimestamp,
} from "./types";
export type { ImportRow, ImportRowResult, ImportSummary } from "./api/useImportMembers";
