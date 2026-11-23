import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DELETE } from "../../../src/api/wallet/banks/route";
import { getAuthPayload } from "../../../src/lib/auth-session";
import { logAuditEvent } from "../../../src/server/services/auditService";
import { bankAccounts } from "../../../src/lib/db/schema";

jest.mock("../../../src/lib/auth-session", () => ({
  getAuthPayload: jest.fn(),
}));

jest.mock("../../../src/server/services/auditService", () => ({
  ...jest.requireActual("../../../src/server/services/auditService"),
  logAuditEvent: jest.fn(),
}));

jest.mock("../../../src/lib/db", () => {
  const returning = jest.fn();
  const where = jest.fn(() => ({ returning }));
  const deleteFn = jest.fn(() => ({ where }));
  return {
    db: { delete: deleteFn },
    __mocks: { deleteFn, where, returning },
  };
});

const { __mocks } = jest.requireMock("../../../src/lib/db") as {
  __mocks: {
    deleteFn: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
};

const mockGetAuthPayload = getAuthPayload as jest.Mock;
const mockLogAuditEvent = logAuditEvent as jest.Mock;

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

function unlinkRequest(id: string, headers: Record<string, string> = {}) {
  const req = new NextRequest(`http://localhost:3001/api/wallet/banks/${id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer token", ...headers },
  });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

/** Renders the WHERE clause the handler passed to db.delete(...).where(). */
function renderedWhere() {
  const condition = __mocks.where.mock.calls[0][0] as SQL;
  return new PgDialect().sqlToQuery(condition);
}

describe("DELETE /api/wallet/banks/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetAuthPayload.mockResolvedValue({
      userId: OWNER_ID,
      email: "owner@example.com",
      role: "user",
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 401 and deletes nothing when the caller is not authenticated", async () => {
    mockGetAuthPayload.mockResolvedValue(null);

    const res = await unlinkRequest(ACCOUNT_ID);

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(__mocks.deleteFn).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-UUID id", "not-a-uuid"],
    ["a SQL fragment", "1 OR 1=1"],
    ["an empty id", ""],
  ])("returns 400 for %s without querying the database", async (_label, id) => {
    const res = await unlinkRequest(id);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toBe("Invalid bank account ID");
    expect(__mocks.deleteFn).not.toHaveBeenCalled();
  });

  it("deletes the caller's account, scoped to both the id and the caller", async () => {
    __mocks.returning.mockResolvedValue([
      { id: ACCOUNT_ID, accountNumberLast4: "6789", isDefault: false },
    ]);

    const res = await unlinkRequest(ACCOUNT_ID);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      message: "Bank account unlinked successfully",
      data: { id: ACCOUNT_ID, wasDefault: false },
    });

    expect(__mocks.deleteFn).toHaveBeenCalledTimes(1);
    expect(__mocks.deleteFn).toHaveBeenCalledWith(bankAccounts);
    const where = renderedWhere();
    expect(where.sql).toBe(
      '("bank_accounts"."id" = $1 and "bank_accounts"."user_id" = $2)',
    );
    expect(where.params).toEqual([ACCOUNT_ID, OWNER_ID]);
  });

  it("returns 404 when the account does not exist or belongs to another user", async () => {
    // The ownership filter is part of the DELETE, so another user's account
    // matches no row, exactly like an id that does not exist.
    __mocks.returning.mockResolvedValue([]);

    const res = await unlinkRequest(ACCOUNT_ID);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.detail).toBe("Bank account not found");
    expect(renderedWhere().params).toEqual([ACCOUNT_ID, OWNER_ID]);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("reports when the unlinked account was the default", async () => {
    __mocks.returning.mockResolvedValue([
      { id: ACCOUNT_ID, accountNumberLast4: "6789", isDefault: true },
    ]);

    const res = await unlinkRequest(ACCOUNT_ID);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ id: ACCOUNT_ID, wasDefault: true });
  });

  it("records an audit event without the full account number", async () => {
    __mocks.returning.mockResolvedValue([
      { id: ACCOUNT_ID, accountNumberLast4: "6789", isDefault: true },
    ]);

    await unlinkRequest(ACCOUNT_ID, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" });

    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "BANK_ACCOUNT_UNLINKED",
        userId: OWNER_ID,
        metadata: {
          bankAccountId: ACCOUNT_ID,
          accountNumberLast4: "6789",
          wasDefault: true,
          ip: "203.0.113.7",
        },
      }),
    );
  });

  it("returns a generic 500 when the database fails", async () => {
    __mocks.returning.mockRejectedValue(new Error("connection terminated"));

    const res = await unlinkRequest(ACCOUNT_ID);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.detail).toBe("Failed to unlink bank account");
    expect(JSON.stringify(body)).not.toContain("connection terminated");
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });
});
