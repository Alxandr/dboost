import { Client, connect } from "@dagger.io/dagger";

const PUBLISH = process.env.PUBLISH === "true";
const VERSION = process.env.VERSION || "latest";

const DB_CLEANER = "dbost-jobs-db-cleanup";
const PRECOMPRESS = "dbost-jobs-precompress";
const MIGRATION = "dbost-migration";
const DBOST = "dbost";
const DEPLOYER = "dbost-jobs-deploy";
const executables = [
	DB_CLEANER,
	PRECOMPRESS,
	MIGRATION,
	DBOST,
	DEPLOYER,
] as const;

// initialize Dagger client
connect(
	async (client: Client) => {
		const pnpmCache = client.cacheVolume("pnpm");
		const targetCache = client.cacheVolume("target");

		const sources = client.host().directory(".", {
			exclude: ["target", "node_modules"],
		});

		const chef = client
			.pipeline("prepare")
			.container()
			.from("docker.io/lukemathwalker/cargo-chef:latest-rust-slim-bookworm")
			.withExec([
				"sh",
				"-c",
				"apt-get update && apt-get install -y curl ca-certificates clang && rm -rf /var/lib/apt/lists/*",
			])
			.withEnvVariable("CARGO_TERM_COLOR", "always")
			.withWorkdir("/app");

		const recipe = chef
			.withDirectory(".", sources, {
				include: [
					"**/Cargo.toml",
					"Cargo.lock",
					"**/main.rs",
					"**/lib.rs",
					"**/build.rs",
				],
			})
			.withExec(["cargo", "chef", "prepare", "--recipe-path", "recipe.json"])
			.file("recipe.json");

		const builder = chef
			.pipeline("build")
			.withFile("recipe.json", recipe)
			.withMountedCache("target", targetCache)
			.withExec([
				"cargo",
				"chef",
				"cook",
				"--release",
				"--workspace",
				"--recipe-path",
				"recipe.json",
			])
			.withDirectory(".", sources, {
				include: ["**/Cargo.toml", "Cargo.lock", "**/*.rs"],
			})
			.withExec(["cargo", "build", "--release", "--workspace"])
			.withExec(["mkdir", "-p", "out"])
			.withExec([
				"cp",
				...executables.map((name) => `target/release/${name}`),
				"out/",
			]);

		const test = builder
			.pipeline("test")
			.withExec(["cargo", "test", "--workspace", "--release"]);

		console.log(`Test output: ${await test.stdout()}`);

		const bins = {
			dbost: builder.file(`out/${DBOST}`),
			precompress: builder.file(`out/${PRECOMPRESS}`),
			deployer: builder.file(`out/${DEPLOYER}`),
			migrator: builder.file(`out/${MIGRATION}`),
			dbCleaner: builder.file(`out/${DB_CLEANER}`),
		};

		const assets = client
			.pipeline("client")
			.container()
			.from("docker.io/node:lts")
			.withWorkdir("/app")
			.withEnvVariable("PNPM_HOME", "/pnpm")
			.withEnvVariable("npm_config_package_import_method", "copy")
			.withEnvVariable("PATH", "$PNPM_HOME:$PATH", { expand: true })
			.withExec(["corepack", "enable"], { skipEntrypoint: true })
			.withMountedCache("/pnpm/store", pnpmCache)
			.withDirectory(".", sources, {
				include: ["package.json", "pnpm-lock.yaml"],
			})
			.withExec(["pnpm", "install", "--frozen-lockfile"])
			.withDirectory(".", sources)
			.withExec(["pnpm", "build"])
			.withFile("/usr/local/bin/dbost-jobs-precompress", bins.precompress)
			.withExec(["/usr/local/bin/dbost-jobs-precompress", "--dir", "/app/dist"])
			.directory("dist");

		const runtime = client
			.pipeline("runtime")
			.container()
			.from("docker.io/debian:bookworm-slim")
			.withExec([
				"sh",
				"-c",
				"apt-get update && apt-get install -y curl tini && rm -rf /var/lib/apt/lists/*",
			])
			.withEntrypoint(["tini", "--"]);

		const deployer = runtime
			.pipeline("deployer")
			.withEnvVariable("TAG", VERSION)
			.withFile(`/usr/local/bin/${DEPLOYER}`, bins.deployer)
			.withDefaultArgs({
				args: [`/usr/local/bin/${DEPLOYER}`],
			});

		const migrator = runtime
			.pipeline("migrator")
			.withFile(`/usr/local/bin/${MIGRATION}`, bins.migrator)
			.withDefaultArgs({
				args: [`/usr/local/bin/${MIGRATION}`],
			});

		const dbCleaner = runtime
			.pipeline("db-cleaner")
			.withFile(`/usr/local/bin/${DB_CLEANER}`, bins.dbCleaner)
			.withDefaultArgs({
				args: [`/usr/local/bin/${DB_CLEANER}`],
			});

		const web = runtime
			.pipeline("web")
			.withFile(`/usr/local/bin/${DBOST}`, bins.dbost)
			.withDirectory("/var/www/public", assets)
			.withEnvVariable("WEB_PUBLIC_PATH", "/var/www/public")
			.withExposedPort(8000)
			.withDefaultArgs({
				args: [`/usr/local/bin/${DBOST}`],
			});

		const tags = new Set([VERSION, "latest"]);
		const images = {
			"ghcr.io/alxandr/dbost": web,
			"ghcr.io/alxandr/dbost/migrator": migrator,
			"ghcr.io/alxandr/dbost/deployer": deployer,
			"ghcr.io/alxandr/dbost/db-cleaner": dbCleaner,
		};

		const tasks: Promise<void>[] = [];
		if (PUBLISH) {
			for (const tag of tags) {
				for (const [name, container] of Object.entries(images)) {
					tasks.push(
						container.publish(`${name}:${tag}`).then((name) => {
							console.log(`Published ${name}`);
						})
					);
				}
			}
		} else {
			for (const container of Object.values(images)) {
				tasks.push(container.sync().then(() => {}));
			}
		}

		await Promise.allSettled(tasks);
	},
	{ LogOutput: process.stdout }
);