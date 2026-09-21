export async function activate(context) {
  context.logger.info("Fixture plugin activated");

  return {
    async ping(input) {
      return {
        pluginId: context.plugin.id,
        version: context.plugin.version,
        input,
      };
    },
  };
}
