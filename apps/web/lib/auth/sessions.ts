/** Session revocation (CSN-050). Database sessions can be deleted, which is why they are used. */
export interface SessionStore {
  deleteAllForUser(userId: string): Promise<number>;
}

/** "Log out everywhere": removes every session row of the user, this device included. */
export async function logOutEverywhere(store: SessionStore, userId: string): Promise<number> {
  return store.deleteAllForUser(userId);
}
