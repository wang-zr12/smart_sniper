const command = process.argv[2];

if (!command || command === 'help') {
  console.log('adapter-cli commands: list, validate-flow');
  process.exit(0);
}

if (command === 'list') {
  const { createDefaultAdapterRegistry } = await import('../../packages/adapters/registry.js');
  console.log(JSON.stringify(createDefaultAdapterRegistry().list(), null, 2));
  process.exit(0);
}

if (command === 'validate-flow') {
  throw new Error('validate-flow is not implemented yet; use packages/server/order-shared/flow-orchestration directly for now.');
}

throw new Error(`Unknown adapter-cli command: ${command}`);
