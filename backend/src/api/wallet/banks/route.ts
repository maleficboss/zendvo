import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bankAccounts } from "@/lib/db/schema";
import { getAuthPayload } from "@/lib/auth-session";
import { createProblemDetails } from "@/lib/api-utils";
import {
  AuditEventType,
  logAuditEvent,
} from "@/server/services/auditService";

// bank_accounts.id is a Postgres uuid; anything else would make the query
// throw ("invalid input syntax for type uuid") and surface as a 500.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getClientIp = (request: NextRequest): string =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip") ||
  "127.0.0.1";

/**
 * DELETE /api/wallet/banks/:id
 *
 * Unlinks one of the caller's saved bank accounts by permanently deleting its
 * bank_accounts row.
 *
 * Ownership is enforced inside the DELETE statement itself
 * (`id = :id AND user_id = <caller>`), so there is no gap between an
 * ownership check and the delete. An account that belongs to another user
 * gets the same 404 as one that does not exist, so the endpoint cannot be
 * used to confirm other users' bank account IDs.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
) {
  try {
    const authPayload = await getAuthPayload(request);
    if (!authPayload) {
      return createProblemDetails(
        "about:blank",
        "Unauthorized",
        401,
        "Authentication required",
      );
    }

    const { userId } = authPayload;
    const { id } = await context.params;

    if (!id || !UUID_REGEX.test(id)) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "Invalid bank account ID",
      );
    }

    const [unlinked] = await db
      .delete(bankAccounts)
      .where(and(eq(bankAccounts.id, id), eq(bankAccounts.userId, userId)))
      .returning({
        id: bankAccounts.id,
        accountNumberLast4: bankAccounts.accountNumberLast4,
        isDefault: bankAccounts.isDefault,
      });

    if (!unlinked) {
      return createProblemDetails(
        "about:blank",
        "Not Found",
        404,
        "Bank account not found",
      );
    }

    logAuditEvent({
      timestamp: new Date(),
      eventType: AuditEventType.BANK_ACCOUNT_UNLINKED,
      userId,
      metadata: {
        bankAccountId: unlinked.id,
        accountNumberLast4: unlinked.accountNumberLast4,
        wasDefault: unlinked.isDefault,
        ip: getClientIp(request),
      },
      message: `Bank account ${unlinked.id} unlinked by user ${userId}`,
    });

    return NextResponse.json(
      {
        success: true,
        message: "Bank account unlinked successfully",
        data: {
          id: unlinked.id,
          wasDefault: unlinked.isDefault,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[UNLINK_BANK_ACCOUNT_ERROR]", error);
    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Failed to unlink bank account",
    );
  }
}
