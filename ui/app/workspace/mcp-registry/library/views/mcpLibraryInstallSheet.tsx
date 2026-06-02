import { Button } from "@/components/ui/button";
import { EnvVarInput } from "@/components/ui/envVarInput";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { HeadersTable } from "@/components/ui/headersTable";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage, useCreateMCPClientMutation } from "@/lib/store";
import { CreateMCPClientRequest, EnvVar, MCPAuthType, MCPLibraryEntry } from "@/lib/types/mcp";
import { parseArrayFromText } from "@/lib/utils/array";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { OAuth2Authorizer } from "../../views/oauth2Authorizer";

const MCP_ICON_FALLBACK = "/images/mcp.svg";

interface MCPLibraryInstallSheetProps {
	server: MCPLibraryEntry;
	open: boolean;
	onClose: () => void;
	onInstalled: () => void;
}

const emptyEnvVar: EnvVar = { value: "", env_var: "", from_env: false };

function buildInitialValues(server: MCPLibraryEntry): CreateMCPClientRequest {
	const authType = (server.auth_type || "none") as MCPAuthType;
	const isStdio = server.connection_type === "stdio";
	return {
		name: server.name,
		is_code_mode_client: false,
		is_ping_available: true,
		connection_type: server.connection_type || "http",
		connection_string: isStdio ? undefined : server.connection_url ? { value: server.connection_url, env_var: "", from_env: false } : emptyEnvVar,
		stdio_config: isStdio && server.stdio_config ? server.stdio_config : undefined,
		auth_type: authType,
		headers: authType === "headers" ? { Authorization: { value: "", env_var: "", from_env: false } } : undefined,
	};
}

export function MCPLibraryInstallSheet({ server, open, onClose, onInstalled }: MCPLibraryInstallSheetProps) {
	const hasCreateMCPClientAccess = useRbac(RbacResource.MCPGateway, RbacOperation.Create);
	const { toast } = useToast();
	const [createMCPClient] = useCreateMCPClientMutation();
	const [isLoading, setIsLoading] = useState(false);
	const [scopesText, setScopesText] = useState("");
	const [envVars, setEnvVars] = useState<Record<string, string>>({});
	const [oauthFlow, setOauthFlow] = useState<{
		authorizeUrl: string;
		oauthConfigId: string;
		mcpClientId: string;
		isPerUserOauth?: boolean;
	} | null>(null);

	const defaultValues = useMemo(() => buildInitialValues(server), [server]);
	const form = useForm<CreateMCPClientRequest>({ defaultValues });
	const { control, handleSubmit, reset, setValue, watch, setError, clearErrors } = form;
	const authType = watch("auth_type") || "none";
	const headers = watch("headers");

	// Build initial env vars map from stdio_config.envs
	const initialEnvVars = useMemo(() => {
		if (server.connection_type !== "stdio" || !server.stdio_config?.envs) return {};
		const map: Record<string, string> = {};
		for (const env of server.stdio_config.envs) {
			map[env] = "";
		}
		return map;
	}, [server]);

	useEffect(() => {
		if (!open) return;
		reset(defaultValues);
		setScopesText("");
		setEnvVars(initialEnvVars);
		setOauthFlow(null);
		setIsLoading(false);
	}, [defaultValues, initialEnvVars, open, reset]);

	const headersValidationError = useMemo(() => {
		if (authType !== "headers" || !headers) return null;
		for (const [key, envVar] of Object.entries(headers)) {
			if (!envVar.value && !envVar.env_var) {
				return `Header "${key}" must have a value`;
			}
		}
		return null;
	}, [authType, headers]);

	const onSubmit = async (data: CreateMCPClientRequest) => {
		let hasErrors = false;

		if (!data.name.trim()) {
			setError("name", { message: "Server name is required" });
			hasErrors = true;
		} else if (!/^[a-zA-Z0-9_]+$/.test(data.name)) {
			setError("name", { message: "Server name can only contain letters, numbers, and underscores" });
			hasErrors = true;
		}

		if (authType === "oauth" || authType === "per_user_oauth") {
			if (data.oauth_config?.authorize_url && !/^https?:\/\/.+$/.test(data.oauth_config.authorize_url)) {
				setError("oauth_config.authorize_url", { message: "Authorize URL must start with http:// or https://" });
				hasErrors = true;
			}
			if (data.oauth_config?.token_url && !/^https?:\/\/.+$/.test(data.oauth_config.token_url)) {
				setError("oauth_config.token_url", { message: "Token URL must start with http:// or https://" });
				hasErrors = true;
			}
			if (data.oauth_config?.registration_url && !/^https?:\/\/.+$/.test(data.oauth_config.registration_url)) {
				setError("oauth_config.registration_url", { message: "Registration URL must start with http:// or https://" });
				hasErrors = true;
			}
		}

		if (headersValidationError || hasErrors) return;

		const isStdio = server.connection_type === "stdio";
		const connectionUrl = server.connection_url || "";
		const stdioConfig =
			isStdio && server.stdio_config
				? {
					command: server.stdio_config.command,
					args: server.stdio_config.args || [],
					// Backend accepts inline KEY=value assignments in envs; fall back to the
					// bare name when no value is provided (read from Bifrost's environment).
					envs: (server.stdio_config.envs || []).map((name) => {
						const val = envVars[name]?.trim();
						return val ? `${name}=${val}` : name;
					}),
				}
				: undefined;
		const payload: CreateMCPClientRequest = {
			...data,
			connection_type: server.connection_type || "http",
			connection_string: isStdio ? undefined : { value: connectionUrl, env_var: "", from_env: false },
			stdio_config: stdioConfig,
			is_code_mode_client: false,
			is_ping_available: true,
			oauth_config:
				authType === "oauth" || authType === "per_user_oauth"
					? {
						client_id: data.oauth_config?.client_id ?? emptyEnvVar,
						client_secret:
							data.oauth_config?.client_secret?.value || data.oauth_config?.client_secret?.from_env
								? data.oauth_config.client_secret
								: undefined,
						authorize_url: data.oauth_config?.authorize_url || undefined,
						token_url: data.oauth_config?.token_url || undefined,
						registration_url: data.oauth_config?.registration_url || undefined,
						scopes: scopesText.trim() ? parseArrayFromText(scopesText) : undefined,
						server_url: connectionUrl || undefined,
					}
					: undefined,
			headers: authType === "headers" && data.headers && Object.keys(data.headers).length > 0 ? data.headers : undefined,
			tools_to_execute: ["*"],
		};

		try {
			setIsLoading(true);
			const response = await createMCPClient(payload).unwrap();
			setIsLoading(false);

			if (response.status === "pending_oauth" && response.authorize_url) {
				setOauthFlow({
					authorizeUrl: response.authorize_url,
					oauthConfigId: response.oauth_config_id,
					mcpClientId: response.mcp_client_id,
					isPerUserOauth: authType === "per_user_oauth",
				});
				return;
			}

			toast({ title: "Installed", description: `${server.name} MCP server installed.` });
			onInstalled();
			onClose();
		} catch (error) {
			setIsLoading(false);
			toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
		}
	};

	const iconUrl = server.icon_url || MCP_ICON_FALLBACK;
	const isStdio = server.connection_type === "stdio";
	const displayUrl =
		server.connection_url || (server.stdio_config ? `${server.stdio_config.command} ${(server.stdio_config.args || []).join(" ")}` : "—");

	return (
		<Sheet open={open} onOpenChange={(sheetOpen) => !sheetOpen && !oauthFlow && onClose()}>
			<SheetContent className="flex w-full flex-col overflow-x-hidden p-0 px-0 pt-4">
				<SheetHeader className="flex flex-col items-start py-4" headerClassName="mb-0 sticky -top-4 bg-card z-10 px-8">
					<SheetTitle>Install {server.name}</SheetTitle>
					<SheetDescription>Review the connection and choose how Bifrost should authenticate to this MCP server.</SheetDescription>
				</SheetHeader>

				<Form {...form}>
					<form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
						<div className="flex-1 space-y-4 px-8 pt-2 pb-4">
							<div className="flex items-center gap-3 rounded-sm border p-3">
								<img
									src={iconUrl}
									alt=""
									className="h-10 w-10 rounded-sm border bg-white object-contain p-1"
									onError={(event) => {
										event.currentTarget.onerror = null;
										event.currentTarget.src = MCP_ICON_FALLBACK;
									}}
								/>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">{server.name}</p>
									<p className="text-muted-foreground truncate text-xs">{displayUrl}</p>
								</div>
							</div>

							<FormField
								control={control}
								name="name"
								rules={{
									required: "Server name is required",
									minLength: { value: 3, message: "Server name must be at least 3 characters" },
									maxLength: { value: 50, message: "Server name cannot exceed 50 characters" },
									validate: {
										format: (value) => /^[a-zA-Z0-9_]+$/.test(value) || "Server name can only contain letters, numbers, and underscores",
										noLeadingDigit: (value) => !/^[0-9]/.test(value) || "Server name cannot start with a number",
									},
								}}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Server Name</FormLabel>
										<FormControl>
											<Input {...field} data-testid="library-mcp-name-input" maxLength={50} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							{isStdio && server.stdio_config?.envs && server.stdio_config.envs.length > 0 && (
								<div className="space-y-2">
									<div className="flex items-center gap-2">
										<Label>Environment Variables</Label>
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Info className="text-muted-foreground h-4 w-4 cursor-help" />
												</TooltipTrigger>
												<TooltipContent className="max-w-xs">
													<p>Provide a value for each variable, or leave blank to read it from the environment where Bifrost runs.</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									</div>
									<div className="rounded-md border">
										<table className="w-full table-fixed">
											<thead>
												<tr className="border-b">
													<th className="text-muted-foreground w-[40%] px-4 py-2 text-left text-xs font-medium">Name</th>
													<th className="text-muted-foreground px-4 py-2 text-left text-xs font-medium">Value</th>
												</tr>
											</thead>
											<tbody>
												{server.stdio_config.envs.map((env) => (
													<tr key={env} className="border-b last:border-0">
														<td className="p-2">
															<Input value={env} readOnly className="border-0 font-mono text-xs focus-visible:ring-0 focus-visible:ring-offset-0" />
														</td>
														<td className="p-2">
															<Input
																value={envVars[env] || ""}
																onChange={(e) => setEnvVars((prev) => ({ ...prev, [env]: e.target.value }))}
																placeholder="Value (or leave blank to use host env)"
																className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
																data-testid={`library-env-${env}`}
															/>
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</div>
							)}

							<FormField
								control={control}
								name="auth_type"
								render={({ field }) => (
									<FormItem className="w-full">
										<FormLabel>Authentication Type</FormLabel>
										<Select
											value={field.value}
											onValueChange={(value: MCPAuthType) => {
												field.onChange(value);
												if (value !== "headers") setValue("headers", undefined);
												if (value !== "oauth" && value !== "per_user_oauth") setValue("oauth_config", undefined);
												if (value === "headers") setValue("headers", { Authorization: { value: "", env_var: "", from_env: false } });
												clearErrors();
											}}
										>
											<FormControl>
												<SelectTrigger className="w-full" data-testid="library-auth-type-select">
													<SelectValue placeholder="Select authentication type" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="none" data-testid="library-auth-type-none">
													None
												</SelectItem>
												<SelectItem value="headers" data-testid="library-auth-type-headers">
													Headers
												</SelectItem>
												<SelectItem value="oauth" data-testid="library-auth-type-oauth">
													OAuth 2.0
												</SelectItem>
												<SelectItem value="per_user_oauth" data-testid="library-auth-type-per-user-oauth">
													Per-User OAuth 2.0
												</SelectItem>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>

							{authType === "headers" && (
								<FormField
									control={control}
									name="headers"
									render={({ field }) => (
										<FormItem data-testid="library-mcp-headers-table">
											<HeadersTable
												value={field.value || {}}
												onChange={field.onChange}
												keyPlaceholder="Header name"
												valuePlaceholder="Header value"
												label="Headers"
												useEnvVarInput
											/>
											{headersValidationError && <p className="text-destructive text-xs">{headersValidationError}</p>}
											<FormMessage />
										</FormItem>
									)}
								/>
							)}

							{(authType === "oauth" || authType === "per_user_oauth") && (
								<>
									<FormField
										control={control}
										name="oauth_config.client_id"
										render={({ field }) => (
											<FormItem>
												<div className="flex items-center gap-2">
													<FormLabel>OAuth Client ID (optional)</FormLabel>
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger asChild>
																<Info className="text-muted-foreground h-4 w-4 cursor-help" />
															</TooltipTrigger>
															<TooltipContent className="max-w-xs">
																<p>Leave empty to use Dynamic Client Registration when the provider supports it.</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
												</div>
												<FormControl>
													<EnvVarInput
														value={field.value}
														onChange={field.onChange}
														placeholder="your-client-id"
														data-testid="library-oauth-client-id"
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>

									<FormField
										control={control}
										name="oauth_config.client_secret"
										render={({ field }) => (
											<FormItem>
												<FormLabel>OAuth Client Secret (optional for PKCE)</FormLabel>
												<FormControl>
													<EnvVarInput
														value={field.value}
														onChange={field.onChange}
														placeholder="your-client-secret"
														hideValueWhenEnv
														maskNonEnvValue
														data-testid="library-oauth-client-secret"
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>

									<FormField
										control={control}
										name="oauth_config.authorize_url"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Authorization URL (optional, auto-discovered)</FormLabel>
												<FormControl>
													<Input
														{...field}
														value={field.value ?? ""}
														onChange={(event) => {
															field.onChange(event);
															clearErrors("oauth_config.authorize_url");
														}}
														placeholder="https://provider.com/oauth/authorize"
														data-testid="library-oauth-authorize-url"
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>

									<FormField
										control={control}
										name="oauth_config.token_url"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Token URL (optional, auto-discovered)</FormLabel>
												<FormControl>
													<Input
														{...field}
														value={field.value ?? ""}
														onChange={(event) => {
															field.onChange(event);
															clearErrors("oauth_config.token_url");
														}}
														placeholder="https://provider.com/oauth/token"
														data-testid="library-oauth-token-url"
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>

									<FormField
										control={control}
										name="oauth_config.registration_url"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Registration URL (optional, auto-discovered)</FormLabel>
												<FormControl>
													<Input
														{...field}
														value={field.value ?? ""}
														onChange={(event) => {
															field.onChange(event);
															clearErrors("oauth_config.registration_url");
														}}
														placeholder="https://provider.com/oauth/register"
														data-testid="library-oauth-registration-url"
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>

									<div className="space-y-2">
										<Label>Scopes (optional, comma-separated)</Label>
										<Input
											value={scopesText}
											onChange={(event) => setScopesText(event.target.value)}
											placeholder="read, write, admin"
											data-testid="library-oauth-scopes-input"
										/>
									</div>
								</>
							)}
						</div>

						<div className="border-border bg-card sticky bottom-0 z-10 border-t px-8 py-4">
							<div className="flex justify-end gap-2">
								<Button type="button" variant="outline" onClick={onClose} disabled={isLoading} data-testid="library-install-cancel-btn">
									Cancel
								</Button>
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<span className="inline-block">
												<Button
													type="submit"
													disabled={isLoading || !hasCreateMCPClientAccess}
													isLoading={isLoading}
													data-testid="library-install-submit-btn"
												>
													Install
												</Button>
											</span>
										</TooltipTrigger>
										{!hasCreateMCPClientAccess && (
											<TooltipContent>
												<p>You don't have permission to perform this action</p>
											</TooltipContent>
										)}
									</Tooltip>
								</TooltipProvider>
							</div>
						</div>
					</form>
				</Form>
			</SheetContent>

			{oauthFlow && (
				<OAuth2Authorizer
					open={!!oauthFlow}
					onClose={() => setOauthFlow(null)}
					onSuccess={() => {
						toast({ title: "Installed", description: `${server.name} MCP server connected with OAuth.` });
						setOauthFlow(null);
						onInstalled();
						onClose();
					}}
					onError={(error) => {
						toast({ title: "OAuth Error", description: error, variant: "destructive" });
					}}
					authorizeUrl={oauthFlow.authorizeUrl}
					oauthConfigId={oauthFlow.oauthConfigId}
					mcpClientId={oauthFlow.mcpClientId}
					isPerUserOauth={oauthFlow.isPerUserOauth}
				/>
			)}
		</Sheet>
	);
}