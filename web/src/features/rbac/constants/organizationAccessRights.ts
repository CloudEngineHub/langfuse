import { type OrganizationRole } from "@langfuse/shared";

const scopes = [
  "projects:create",
  "organizations:update",
  "members:view",
  "members:CUD",
] as const;

// type string of all Resource:Action, e.g. "members:read"
export type Scope = (typeof scopes)[number];

export const roleAccessRights: Record<OrganizationRole, Scope[]> = {
  OWNER: [
    "projects:create",
    "organizations:update",
    "members:CUD",
    "members:view",
  ],
  MEMBER: ["members:view"],
  NONE: [],
};