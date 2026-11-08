import { ForbiddenException, Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Identidade autenticada do provedor (máquina-a-máquina). */
export interface ProviderIdentity {
  /** providerId autorizado para este client — comparado com o payload. */
  providerId: string;
  subject: string;
  /** Pode operar wallets (POST /wallets, reconciliação)? */
  isBackoffice: boolean;
}

/**
 * Porta de autenticação. A implementação concreta valida o token contra o
 * Identity Provider (OIDC/JWKS); a aplicação nunca mantém usuários/senhas.
 */
export interface ProviderIdentityPort {
  authenticate(bearerToken: string): Promise<ProviderIdentity>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');

export type AuthenticatedRequest = Request & { provider?: ProviderIdentity };

/**
 * Guard aplicado aos endpoints de negócio (health e metrics ficam abertos).
 * Sem IdP configurado (AUTH_ENABLED=false) o port é `undefined` e o guard é
 * no-op — ponto de extensão explícito, documentado no ARCHITECTURE.md.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort | undefined) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.identity) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    try {
      req.provider = await this.identity.authenticate(header.slice('Bearer '.length));
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}

/** Garante que o provedor autenticado só opera em nome de si mesmo. */
export function assertProviderMatches(req: AuthenticatedRequest, providerId: string): void {
  if (req.provider && req.provider.providerId !== providerId) {
    throw new ForbiddenException(`Authenticated client cannot act as provider "${providerId}"`);
  }
}

export function assertBackoffice(req: AuthenticatedRequest): void {
  if (req.provider && !req.provider.isBackoffice) {
    throw new ForbiddenException('Backoffice role required');
  }
}
