export interface School {
  emailDomains: string[];
  issuerKey: string;
  identity?: import("./unified-identity.js").UnifiedVerification;
}
