import { prisma } from '@coinsnipe/db';
import { handleLogOutEverywhere } from '../../../../../lib/auth/meHandlers';
import { requireSessionUserId } from '../../../../../lib/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** DELETE /api/v1/me/sessions: log out everywhere (deletes every session of the caller). */
export async function DELETE(request: Request): Promise<Response> {
  return handleLogOutEverywhere(request, {
    getUserId: requireSessionUserId,
    sessions: {
      deleteAllForUser: async (userId) =>
        (await prisma.session.deleteMany({ where: { userId } })).count,
    },
  });
}
