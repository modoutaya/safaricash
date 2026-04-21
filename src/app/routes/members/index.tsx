// Story 2.1 — /members route. Renders the full list via the feature's
// MemberList component (loading / error / empty / populated states are
// all owned by MemberList).

import { MemberList } from "@/features/member";

export default function MembersRoute() {
  return <MemberList />;
}
