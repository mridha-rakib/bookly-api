import { Types } from "mongoose";

import type { TokenService } from "../../src/modules/auth/token.service.js";
import type { UserRole } from "../../src/modules/user/user.types.js";

/**
 * Issues an access token the way production does: bound (`sid`) to a real, persisted refresh
 * session family. Database tests must use this instead of signing an unbound token, because the
 * auth middleware rejects access tokens whose family is not live.
 */
export const issueTestAccessToken = async (
  tokenService: TokenService,
  input: { userId: Types.ObjectId | string; role: UserRole },
): Promise<string> => {
  const { tokenFamilyId } = await tokenService.createRefreshSession({
    userId: new Types.ObjectId(String(input.userId)),
  });
  return tokenService.createAccessToken({ ...input, sessionFamilyId: tokenFamilyId });
};
