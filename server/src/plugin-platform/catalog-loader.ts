import { PluginCatalogSchema, verifyEd25519Signature, type PluginCatalog } from "@memorylane/plugin-sdk";
import type { KeyLike } from "node:crypto";
import fs from "node:fs";

export interface CatalogLoaderOptions {
  publicKey: KeyLike;
  allowHttp?: boolean;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

export class PluginCatalogLoader {
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CatalogLoaderOptions) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async load(catalogUrl: string, signatureUrl = `${catalogUrl}.sig`): Promise<PluginCatalog> {
    this.validateUrl(catalogUrl);
    this.validateUrl(signatureUrl);
    const [catalogResponse, signatureResponse] = await Promise.all([
      this.fetchImpl(catalogUrl, { redirect: "error" }),
      this.fetchImpl(signatureUrl, { redirect: "error" }),
    ]);
    if (!catalogResponse.ok) throw new Error(`Plugin catalog returned HTTP ${catalogResponse.status}`);
    if (!signatureResponse.ok) throw new Error(`Plugin catalog signature returned HTTP ${signatureResponse.status}`);
    const declaredLength = Number(catalogResponse.headers.get("content-length") ?? 0);
    if (declaredLength > this.maxBytes) throw new Error("Plugin catalog exceeds the size limit");
    const bytes = new Uint8Array(await catalogResponse.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) throw new Error("Plugin catalog exceeds the size limit");
    const signature = (await signatureResponse.text()).trim();
    if (!verifyEd25519Signature(bytes, signature, this.options.publicKey)) throw new Error("Plugin catalog signature is invalid");
    return PluginCatalogSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }

  loadDirectory(directory: string): PluginCatalog {
    const bytes = fs.readFileSync(`${directory}/catalog.json`);
    if (bytes.byteLength > this.maxBytes) throw new Error("Plugin catalog exceeds the size limit");
    const signature = fs.readFileSync(`${directory}/catalog.json.sig`, "utf8").trim();
    if (!verifyEd25519Signature(bytes, signature, this.options.publicKey)) throw new Error("Plugin catalog signature is invalid");
    return PluginCatalogSchema.parse(JSON.parse(bytes.toString("utf8")));
  }

  private validateUrl(value: string): void {
    const protocol = new URL(value).protocol;
    if (protocol !== "https:" && !(this.options.allowHttp && protocol === "http:")) throw new Error("Plugin catalogs require HTTPS");
  }
}
