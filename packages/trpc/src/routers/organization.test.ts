import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbMock,
  getOrganizationAccessMock,
  getOrganizationsMock,
  getOrganizationByIdMock,
  getMembersMock,
  getInvitesMock,
  getInviteByIdMock,
  connectUserToOrganizationMock,
} = vi.hoisted(() => ({
  dbMock: {
    member: {
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    projectAccess: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    organization: {
      update: vi.fn(),
    },
    project: {
      updateMany: vi.fn(),
    },
    invite: {
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(async (ops: unknown, _opts?: unknown) => {
      if (typeof ops === 'function') {
        return (ops as (tx: typeof dbMock) => unknown)(dbMock);
      }
      return Array.isArray(ops) ? Promise.all(ops) : ops;
    }),
  },
  getOrganizationAccessMock: vi.fn(),
  getOrganizationsMock: vi.fn(),
  getOrganizationByIdMock: vi.fn(),
  getMembersMock: vi.fn(),
  getInvitesMock: vi.fn(),
  getInviteByIdMock: vi.fn(),
  connectUserToOrganizationMock: vi.fn(),
}));

getOrganizationAccessMock.clear = vi.fn().mockResolvedValue(1);

vi.mock('@openpanel/db', () => ({
  db: dbMock,
  getOrganizationAccess: getOrganizationAccessMock,
  getOrganizations: getOrganizationsMock,
  getOrganizationById: getOrganizationByIdMock,
  getMembers: getMembersMock,
  getInvites: getInvitesMock,
  getInviteById: getInviteByIdMock,
  connectUserToOrganization: connectUserToOrganizationMock,
  getProjectAccess: vi.fn(),
  getClientAccess: vi.fn(),
  getProjectById: vi.fn(),
  canWriteProject: vi.fn(),
  runWithAlsSession: (_sessionId: string | null, fn: () => unknown) => fn(),
}));

vi.mock('@openpanel/email', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@openpanel/common/server', () => ({
  generateSecureId: vi.fn(() => 'invite_test'),
}));

const { organizationRouter } = await import('./organization');

const ORG_ID = 'org-1';
const ADMIN_ID = 'admin-1';
const MEMBER_USER_ID = 'user-2';
const MEMBER_ROW = {
  id: 'member-row-2',
  userId: MEMBER_USER_ID,
  organizationId: ORG_ID,
  role: 'org:member' as const,
  email: 'member@example.com',
};

const adminCaller = () =>
  organizationRouter.createCaller({
    session: { userId: ADMIN_ID, session: { id: 'session-1' } },
    req: { log: { info: vi.fn(), error: vi.fn() } },
    res: {},
    setCookie: vi.fn(),
    cookies: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  getOrganizationAccessMock.mockResolvedValue({ role: 'org:admin' });
});

describe('organization.updateMemberRole', () => {
  it('promotes a member to org:admin', async () => {
    dbMock.member.findFirst.mockResolvedValue(MEMBER_ROW);
    dbMock.member.update.mockResolvedValue({
      ...MEMBER_ROW,
      role: 'org:admin',
    });

    const result = await adminCaller().updateMemberRole({
      organizationId: ORG_ID,
      userId: MEMBER_USER_ID,
      role: 'org:admin',
    });

    expect(dbMock.member.update).toHaveBeenCalledWith({
      where: { id: MEMBER_ROW.id },
      data: { role: 'org:admin' },
    });
    expect(result.role).toBe('org:admin');
  });

  it('rejects a plain org member from changing roles', async () => {
    getOrganizationAccessMock.mockResolvedValue({ role: 'org:member' });

    await expect(
      adminCaller().updateMemberRole({
        organizationId: ORG_ID,
        userId: MEMBER_USER_ID,
        role: 'org:admin',
      }),
    ).rejects.toThrow('You do not have access');
  });

  it('rejects updating your own role', async () => {
    await expect(
      adminCaller().updateMemberRole({
        organizationId: ORG_ID,
        userId: ADMIN_ID,
        role: 'org:member',
      }),
    ).rejects.toThrow('You cannot update your own role');
  });

  it('refuses to demote the last organization admin', async () => {
    dbMock.member.findFirst.mockResolvedValue({
      ...MEMBER_ROW,
      userId: 'other-admin',
      role: 'org:admin',
    });
    dbMock.member.count.mockResolvedValue(1);

    await expect(
      adminCaller().updateMemberRole({
        organizationId: ORG_ID,
        userId: 'other-admin',
        role: 'org:member',
      }),
    ).rejects.toThrow('last organization admin');

    expect(dbMock.member.update).not.toHaveBeenCalled();
  });

  it('demotes an admin when another admin remains', async () => {
    dbMock.member.findFirst.mockResolvedValue({
      ...MEMBER_ROW,
      userId: 'other-admin',
      role: 'org:admin',
    });
    dbMock.member.count.mockResolvedValue(2);
    dbMock.member.update.mockResolvedValue({
      ...MEMBER_ROW,
      userId: 'other-admin',
      role: 'org:member',
    });

    const result = await adminCaller().updateMemberRole({
      organizationId: ORG_ID,
      userId: 'other-admin',
      role: 'org:member',
    });

    expect(result.role).toBe('org:member');
    expect(dbMock.member.update).toHaveBeenCalled();
  });

  it('clears cached organization access for the updated member', async () => {
    dbMock.member.findFirst.mockResolvedValue(MEMBER_ROW);
    dbMock.member.update.mockResolvedValue({
      ...MEMBER_ROW,
      role: 'org:admin',
    });

    await adminCaller().updateMemberRole({
      organizationId: ORG_ID,
      userId: MEMBER_USER_ID,
      role: 'org:admin',
    });

    expect(getOrganizationAccessMock.clear).toHaveBeenCalledWith({
      userId: MEMBER_USER_ID,
      organizationId: ORG_ID,
    });
  });

  it('runs the last-admin check and role update in one transaction', async () => {
    dbMock.member.findFirst.mockResolvedValue({
      ...MEMBER_ROW,
      userId: 'other-admin',
      role: 'org:admin',
    });
    dbMock.member.count.mockResolvedValue(2);
    dbMock.member.update.mockResolvedValue({
      ...MEMBER_ROW,
      userId: 'other-admin',
      role: 'org:member',
    });

    await adminCaller().updateMemberRole({
      organizationId: ORG_ID,
      userId: 'other-admin',
      role: 'org:member',
    });

    expect(dbMock.$transaction).toHaveBeenCalled();
    const txArg = dbMock.$transaction.mock.calls[0]?.[0];
    expect(typeof txArg).toBe('function');
  });
});

describe('organization.updateMember', () => {
  it('updates role and project access in one transaction', async () => {
    dbMock.member.findFirst.mockResolvedValue(MEMBER_ROW);
    dbMock.member.update.mockResolvedValue({
      ...MEMBER_ROW,
      role: 'org:admin',
    });
    dbMock.projectAccess.deleteMany.mockResolvedValue({ count: 0 });
    dbMock.projectAccess.createMany.mockResolvedValue({ count: 1 });

    await adminCaller().updateMember({
      organizationId: ORG_ID,
      userId: MEMBER_USER_ID,
      role: 'org:admin',
      access: [{ projectId: 'proj-1', level: 'write' }],
    });

    expect(dbMock.$transaction).toHaveBeenCalled();
    expect(dbMock.member.update).toHaveBeenCalled();
    expect(dbMock.projectAccess.deleteMany).toHaveBeenCalled();
    expect(dbMock.projectAccess.createMany).toHaveBeenCalled();
    expect(getOrganizationAccessMock.clear).toHaveBeenCalledWith({
      userId: MEMBER_USER_ID,
      organizationId: ORG_ID,
    });
  });
});
