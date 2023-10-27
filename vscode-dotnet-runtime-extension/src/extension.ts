/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import open = require('open');
import * as os from 'os';
import * as vscode from 'vscode';
import {
    AcquireErrorConfiguration,
    AcquisitionInvoker,
    callWithErrorHandling,
    DotnetAcquisitionMissingLinuxDependencies,
    DotnetAcquisitionRequested,
    DotnetAcquisitionStatusRequested,
    DotnetCoreAcquisitionWorker,
    DotnetCoreDependencyInstaller,
    DotnetExistingPathResolutionCompleted,
    DotnetRuntimeAcquisitionStarted,
    DotnetRuntimeAcquisitionTotalSuccessEvent,
    enableExtensionTelemetry,
    ErrorConfiguration,
    ExistingPathResolver,
    ExtensionConfigurationWorker,
    formatIssueUrl,
    IDotnetAcquireContext,
    IDotnetAcquireResult,
    IDotnetEnsureDependenciesContext,
    IDotnetUninstallContext,
    IEventStreamContext,
    IExtensionContext,
    IIssueContext,
    InstallationValidator,
    registerEventStream,
    RuntimeInstallationDirectoryProvider,
    VersionResolver,
    VSCodeExtensionContext,
    VSCodeEnvironment,
    WindowDisplayWorker,
} from 'vscode-dotnet-runtime-library';
import { dotnetCoreAcquisitionExtensionId } from './DotnetCoreAcquisitionId';

// tslint:disable no-var-requires
const packageJson = require('../package.json');

// Extension constants
namespace configKeys {
    export const installTimeoutValue = 'installTimeoutValue';
    export const enableTelemetry = 'enableTelemetry';
    export const existingPath = 'existingDotnetPath';
    export const proxyUrl = 'proxyUrl';
}
namespace commandKeys {
    export const acquire = 'acquire';
    export const acquireStatus = 'acquireStatus';
    export const uninstallAll = 'uninstallAll';
    export const showAcquisitionLog = 'showAcquisitionLog';
    export const ensureDotnetDependencies = 'ensureDotnetDependencies';
    export const reportIssue = 'reportIssue';
}

const commandPrefix = 'dotnet';
const configPrefix = 'dotnetAcquisitionExtension';
const displayChannelName = '.NET Runtime';
const defaultTimeoutValue = 600;
const moreInfoUrl = 'https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/troubleshooting-runtime.md';

export function activate(context: vscode.ExtensionContext, extensionContext?: IExtensionContext) {
    const extensionConfiguration = extensionContext !== undefined && extensionContext.extensionConfiguration ?
        extensionContext.extensionConfiguration :
        vscode.workspace.getConfiguration(configPrefix);

    const extensionTelemetryEnabled = enableExtensionTelemetry(extensionConfiguration, configKeys.enableTelemetry);
    const displayWorker = extensionContext ? extensionContext.displayWorker : new WindowDisplayWorker();

    const utilContext = {
        ui : displayWorker,
        vsCodeEnv: new VSCodeEnvironment()
    }

    const eventStreamContext = {
        displayChannelName,
        logPath: context.logPath,
        extensionId: dotnetCoreAcquisitionExtensionId,
        enableTelemetry: extensionTelemetryEnabled,
        telemetryReporter: extensionContext ? extensionContext.telemetryReporter : undefined,
        showLogCommand: `${commandPrefix}.${commandKeys.showAcquisitionLog}`,
        packageJson
    } as IEventStreamContext;
    const [eventStream, outputChannel, loggingObserver, eventStreamObservers] = registerEventStream(eventStreamContext, new VSCodeExtensionContext(context), utilContext);

    const extensionConfigWorker = new ExtensionConfigurationWorker(extensionConfiguration, configKeys.existingPath);
    const issueContext = (errorConfiguration: ErrorConfiguration | undefined, commandName: string, version?: string) => {
        return {
            logger: loggingObserver,
            errorConfiguration: errorConfiguration || AcquireErrorConfiguration.DisplayAllErrorPopups,
            displayWorker,
            extensionConfigWorker,
            eventStream,
            commandName,
            version,
            moreInfoUrl,
            timeoutInfoUrl: `${moreInfoUrl}#install-script-timeouts`
        } as IIssueContext;
    };
    const timeoutValue = extensionConfiguration.get<number>(configKeys.installTimeoutValue);
    if (!fs.existsSync(context.globalStoragePath)) {
        fs.mkdirSync(context.globalStoragePath);
    }
    const resolvedTimeoutSeconds = timeoutValue === undefined ? defaultTimeoutValue : timeoutValue;

    const proxyLink = extensionConfiguration.get<string>(configKeys.proxyUrl);

    const acquisitionWorker = new DotnetCoreAcquisitionWorker({
        storagePath: context.globalStoragePath,
        extensionState: context.globalState,
        eventStream,
        acquisitionInvoker: new AcquisitionInvoker(context.globalState, eventStream, resolvedTimeoutSeconds, utilContext),
        installationValidator: new InstallationValidator(eventStream),
        timeoutValue: resolvedTimeoutSeconds,
        installDirectoryProvider: new RuntimeInstallationDirectoryProvider(context.globalStoragePath),
        proxyUrl: proxyLink,
        isExtensionTelemetryInitiallyEnabled: extensionTelemetryEnabled
    }, utilContext, new VSCodeExtensionContext(context));
    const existingPathResolver = new ExistingPathResolver();
    const versionResolver = new VersionResolver(context.globalState, eventStream, resolvedTimeoutSeconds, proxyLink);

    const dotnetAcquireRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.acquire}`, async (commandContext: IDotnetAcquireContext) => {
        let fullyResolvedVersion = '';
        const dotnetPath = await callWithErrorHandling<Promise<IDotnetAcquireResult>>(async () => {
            eventStream.post(new DotnetRuntimeAcquisitionStarted(commandContext.requestingExtensionId));
            eventStream.post(new DotnetAcquisitionRequested(commandContext.version, commandContext.requestingExtensionId));
            acquisitionWorker.setAcquisitionContext(commandContext);

            if (!commandContext.version || commandContext.version === 'latest') {
                throw new Error(`Cannot acquire .NET version "${commandContext.version}". Please provide a valid version.`);
            }

            const existingPath = existingPathResolver.resolveExistingPath(extensionConfigWorker.getPathConfigurationValue(), commandContext.requestingExtensionId, displayWorker);
            if (existingPath) {
                eventStream.post(new DotnetExistingPathResolutionCompleted(existingPath.dotnetPath));
                return new Promise((resolve) => {
                    resolve(existingPath);
                });
            }

            const version = await versionResolver.getFullRuntimeVersion(commandContext.version);
            fullyResolvedVersion = version;

            if(commandContext.architecture !== undefined)
            {
                acquisitionWorker.installingArchitecture = commandContext.architecture;
            }
            return acquisitionWorker.acquireRuntime(version);
        }, issueContext(commandContext.errorConfiguration, 'acquire', commandContext.version), commandContext.requestingExtensionId);

        const installKey = acquisitionWorker.getInstallKey(fullyResolvedVersion);
        eventStream.post(new DotnetRuntimeAcquisitionTotalSuccessEvent(commandContext.version, installKey, commandContext.requestingExtensionId ?? '', dotnetPath?.dotnetPath ?? ''));
        return dotnetPath;
    });

    const dotnetAcquireStatusRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.acquireStatus}`, async (commandContext: IDotnetAcquireContext) => {
        const pathResult = callWithErrorHandling(async () => {
            eventStream.post(new DotnetAcquisitionStatusRequested(commandContext.version, commandContext.requestingExtensionId));
            const resolvedVersion = await versionResolver.getFullRuntimeVersion(commandContext.version);
            const dotnetPath = await acquisitionWorker.acquireStatus(resolvedVersion, true);
            return dotnetPath;
        }, issueContext(commandContext.errorConfiguration, 'acquireRuntimeStatus'));
        return pathResult;
    });

    const dotnetUninstallAllRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.uninstallAll}`, async (commandContext: IDotnetUninstallContext | undefined) => {
        await callWithErrorHandling(() => acquisitionWorker.uninstallAll(), issueContext(commandContext ? commandContext.errorConfiguration : undefined, 'uninstallAll'));
    });

    const showOutputChannelRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.showAcquisitionLog}`, () => outputChannel.show(/* preserveFocus */ false));

    const ensureDependenciesRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.ensureDotnetDependencies}`, async (commandContext: IDotnetEnsureDependenciesContext) => {
        await callWithErrorHandling(async () => {
            if (os.platform() !== 'linux') {
                // We can't handle installing dependencies for anything other than Linux
                return;
            }

            const result = cp.spawnSync(commandContext.command, commandContext.arguments);
            const installer = new DotnetCoreDependencyInstaller();
            if (installer.signalIndicatesMissingLinuxDependencies(result.signal!)) {
                eventStream.post(new DotnetAcquisitionMissingLinuxDependencies());
                await installer.promptLinuxDependencyInstall('Failed to run .NET runtime.');
            }
        }, issueContext(commandContext.errorConfiguration, 'ensureDependencies'));
    });

    const reportIssueRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.reportIssue}`, async () => {
        const [url, issueBody] = formatIssueUrl(undefined, issueContext(AcquireErrorConfiguration.DisableErrorPopups, 'reportIssue'));
        await vscode.env.clipboard.writeText(issueBody);
        open(url);
    });

    context.subscriptions.push(
        dotnetAcquireRegistration,
        dotnetAcquireStatusRegistration,
        dotnetUninstallAllRegistration,
        showOutputChannelRegistration,
        ensureDependenciesRegistration,
        reportIssueRegistration,
        ...eventStreamObservers);
}
