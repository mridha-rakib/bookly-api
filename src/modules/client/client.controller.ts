import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { UserRole } from "../user/user.types.js";
import type {
  ClientBusinessParams,
  ClientIdParams,
  CreateClientBody,
  ListClientsQuery,
  UpdateClientBody,
} from "./client.schema.js";
import type { ClientService } from "./client.service.js";

export class ClientController {
  public constructor(private readonly clientService: ClientService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireAuth(request);
    const params = request.validated?.params as ClientBusinessParams;
    const query = request.validated?.query as ListClientsQuery;
    const result = await this.clientService.listClients(userId, role, params.businessId, query);
    sendSuccess(response, 200, "Clients", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireAuth(request);
    const params = request.validated?.params as ClientIdParams;
    const result = await this.clientService.getClient(
      userId,
      role,
      params.businessId,
      params.clientId,
    );
    sendSuccess(response, 200, "Client", result);
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireAuth(request);
    const params = request.validated?.params as ClientBusinessParams;
    const body = request.validated?.body as CreateClientBody;
    const result = await this.clientService.createClient(userId, role, params.businessId, body);
    sendSuccess(response, 201, "Client created", result);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireAuth(request);
    const params = request.validated?.params as ClientIdParams;
    const body = request.validated?.body as UpdateClientBody;
    const result = await this.clientService.updateClient(
      userId,
      role,
      params.businessId,
      params.clientId,
      body,
    );
    sendSuccess(response, 200, "Client updated", result);
  };

  public archive = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireAuth(request);
    const params = request.validated?.params as ClientIdParams;
    await this.clientService.archiveClient(userId, role, params.businessId, params.clientId);
    sendSuccess(response, 200, "Client archived");
  };

  public restore = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireAuth(request);
    const params = request.validated?.params as ClientIdParams;
    const result = await this.clientService.restoreClient(
      userId,
      role,
      params.businessId,
      params.clientId,
    );
    sendSuccess(response, 200, "Client restored", result);
  };

  private requireAuth(request: Request): { userId: string; role: UserRole } {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return { userId: request.auth.userId, role: request.auth.role };
  }
}
