import adapter from "@sveltejs/adapter-static";

const config = {
    kit: { adapter: adapter() },
    compilerOptions: {
        warningFilter: (warning) =>
            !warning.filename?.includes("node_modules") &&
            !warning.code.startsWith("a11y"),
    },
};

export default config;
