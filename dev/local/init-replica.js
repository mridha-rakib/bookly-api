// Explicit setup action for a NEW disposable project volume only; never reconfigure a replica.
const expected = { _id: "bookly-local", members: [{ _id: 0, host: "127.0.0.1:27117" }] };
let configuration;
try {
  configuration = rs.conf();
} catch (error) {
  if (error.code !== 94) throw error; // NotYetInitialized only
}
if (configuration) {
  if (
    configuration._id !== expected._id ||
    configuration.members.length !== 1 ||
    configuration.members[0]._id !== 0 ||
    configuration.members[0].host !== expected.members[0].host
  ) {
    throw Error("Refusing unexpected local replica configuration");
  }
} else {
  const result = rs.initiate(expected);
  if (result.ok !== 1) throw Error("Local replica initialization failed");
}
let primary = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (db.adminCommand({ hello: 1 }).isWritablePrimary) {
    primary = true;
    break;
  }
  sleep(1000);
}
if (!primary) throw Error("Local replica did not elect a primary");
