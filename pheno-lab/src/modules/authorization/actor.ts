export type ActorRole = "ADMIN" | "MANAGER" | "TECHNICIAN";

export type Actor = {
  uid: string;
  org: string;
  role: ActorRole;
};

export type ExperimentAccessResource = {
  organizationId: string;
  createdById: string;
  assigneeId?: string | null;
  members: Array<{ userId: string }>;
};
