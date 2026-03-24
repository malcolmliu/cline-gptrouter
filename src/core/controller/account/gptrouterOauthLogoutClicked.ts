import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { GptrouterAuthService } from "@/services/auth/gptrouter/GptrouterAuthService"
import { Controller } from ".."

export async function gptrouterOauthLogoutClicked(controller: Controller, _: EmptyRequest): Promise<Empty> {
	await GptrouterAuthService.getInstance().logout()
	await controller.postStateToWebview()
	return {}
}
