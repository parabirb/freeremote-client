import adapter from "@sveltejs/adapter-static";

/**
@type {import('@sveltejs/kit').Config}
*/
const config = {
    kit: { adapter: adapter() },
    compilerOptions: {
        // Ignore warnings from dependencies and accessibility hints
        warningFilter: (warning) =>
            !warning.filename?.includes("node_modules") &&
            !warning.code.startsWith("a11y"),
    },
};

export default config;
