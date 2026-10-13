import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

// Mongoose applies the transaction session to every operation in its async scope,
// including existing lead/contact/course services. No Meta call occurs in this scope.
mongoose.set('transactionAsyncLocalStorage', true);
const scope = new AsyncLocalStorage();
export const currentExecution = () => scope.getStore();
export function transactionalEvent(eventId, work) {
  return mongoose.connection.transaction(() => scope.run({ eventId, outbound: 0, notifications: [] }, work), {
    readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000,
  });
}
