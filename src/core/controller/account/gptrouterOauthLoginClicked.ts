import { EmptyRequest, String as ProtoString } from "@shared/proto/cline/common"
import { GptrouterAuthService } from "@/services/auth/gptrouter/GptrouterAuthService"
import { Controller } from ".."

export async function gptrouterOauthLoginClicked(_controller: Controller, _: EmptyRequest): Promise<ProtoString> {
	const url = await GptrouterAuthService.getInstance().createAuthRequest()
	return ProtoString.create({ value: url })
}
