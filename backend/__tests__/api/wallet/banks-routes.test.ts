// routes.ts pulls in every handler. tokens.ts and storage.ts import the
// ESM-only `jose` and `nanoid`, which Jest does not transform under pnpm's
// layout, and no handler runs in this test, so both are stubbed.
jest.mock("../../../src/lib/tokens", () => ({
  verifyAccessToken: jest.fn(),
}));
jest.mock("../../../src/lib/storage", () => ({}));

import { apiRouter } from "../../../src/routes";

describe("apiRouter wallet bank account registrations", () => {
  it("registers DELETE /api/wallet/banks/:id", () => {
    const layer = apiRouter.stack.find(
      (l: any) =>
        l.route?.path === "/api/wallet/banks/:id" &&
        l.route?.methods?.delete === true,
    );

    expect(layer).toBeDefined();
  });
});
