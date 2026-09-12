import { translate } from '@/i18n/i18n'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'
import {
  HeroFlow,
  HeroIntro,
  HeroPaired,
  type PairedDevice,
  type Platform,
  type StepIndex
} from './MobileHero'
import { getInstallCopy, type IosChannel } from './mobile-platform-copy'
import type { MobilePageStage } from './mobile-page-stage'
import { MobilePageToolbar } from './MobilePageToolbar'
import { PhoneCarousel } from './PhoneCarousel'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'
import type { MobileHostStatus } from './use-mobile-host-status'

type MobilePageContentProps = {
  closeMobilePage: () => void
  copyInstallUrl: () => void
  copyPairingCode: () => void
  devices: readonly PairedDevice[]
  enterFlow: () => void
  generatePairing: (rotate: boolean) => void
  canGeneratePairing: boolean
  handleAddressChange: (address: string) => void
  customAddresses: readonly string[]
  selectedAddressIsCustom: boolean
  onCustomAddressSelect: (address: string) => void
  onCustomAddressRemove: (address: string) => void
  beforeCustomAddressChange: (address: string) => Promise<boolean>
  handleBack: () => void
  handleContinue: () => void
  installQrUrl: string | null
  iosChannel: IosChannel
  setIosChannel: (channel: IosChannel) => void
  loadNetworkInterfaces: () => void
  networkInterfaces: MobileNetworkInterface[]
  openAndroidInstallGuide: () => void
  openInstallUrl: () => void
  pairAnotherDevice: () => void
  pairLoading: boolean
  connectionMode: MobilePairingConnectionMode
  handleConnectionModeChange: (mode: MobilePairingConnectionMode) => void
  pairQrDataUrl: string | null
  pairQrSize: number | null
  pairingUrl: string | null
  pairingQrError: boolean
  relayMintFailure: MobileRelayMintFailure | null
  onUseLan: () => void
  onRetryRelay: () => void
  onCopyRelayDiagnostics: () => void
  platform: Platform
  refreshingNetworkInterfaces: boolean
  revokeDevice: (id: string) => void
  revokingDeviceIds: readonly string[]
  selectedAddress: string | undefined
  setPlatform: (platform: Platform) => void
  showMobileButton: boolean
  showPairedDevices: (deviceCount: number) => void
  stage: MobilePageStage | null
  stepIdx: StepIndex
  toggleMobileSidebarButton: () => void
  /** Optional override: when true, render the read-only "Pair from desktop" surface. */
  isRemoteRendererReadOnly?: boolean
  /** Optional override: when true, hide the Anywhere radio and show the unavailable reason. */
  hideAnywhere?: boolean
  /** Read-only context for the toolbar button hint. */
  hostStatus: MobileHostStatus | null
}

export function MobilePageContent({
  closeMobilePage,
  copyInstallUrl,
  copyPairingCode,
  devices,
  enterFlow,
  generatePairing,
  canGeneratePairing,
  handleAddressChange,
  customAddresses,
  selectedAddressIsCustom,
  onCustomAddressSelect,
  onCustomAddressRemove,
  beforeCustomAddressChange,
  handleBack,
  handleContinue,
  installQrUrl,
  iosChannel,
  setIosChannel,
  loadNetworkInterfaces,
  networkInterfaces,
  openAndroidInstallGuide,
  openInstallUrl,
  pairAnotherDevice,
  pairLoading,
  connectionMode,
  handleConnectionModeChange,
  pairQrDataUrl,
  pairQrSize,
  pairingUrl,
  pairingQrError,
  relayMintFailure,
  onUseLan,
  onRetryRelay,
  onCopyRelayDiagnostics,
  platform,
  refreshingNetworkInterfaces,
  revokeDevice,
  revokingDeviceIds,
  selectedAddress,
  setPlatform,
  showMobileButton,
  showPairedDevices,
  stage,
  stepIdx,
  toggleMobileSidebarButton,
  isRemoteRendererReadOnly = false,
  hostStatus = null
}: MobilePageContentProps): React.JSX.Element {
  return (
    <div className="mobile-page-root scrollbar-sleek">
      <MobilePageToolbar
        showMobileButton={showMobileButton}
        onClose={closeMobilePage}
        onToggleMobileSidebarButton={toggleMobileSidebarButton}
        isRemoteRendererReadOnly={isRemoteRendererReadOnly}
      />
      <section className="mp-hero">
        <div className="mp-hero-copy">
          {isRemoteRendererReadOnly ? (
            <div
              className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm"
              data-testid="remote-renderer-notice"
            >
              <h2 className="mb-1 font-medium">
                {translate(
                  'auto.components.mobile.MobilePage.c736088782',
                  'Pair from the desktop app'
                )}
              </h2>
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.mobile.MobilePage.a62011e553',
                  'Pair Orca Mobile from the desktop app on this host.'
                )}
              </p>
            </div>
          ) : stage === null ? null : stage === 'intro' ? (
            <HeroIntro onStart={enterFlow} />
          ) : stage === 'paired' ? (
            <HeroPaired
              devices={devices}
              onPairAnother={pairAnotherDevice}
              onRevoke={(id) => revokeDevice(id)}
              revokingDeviceIds={revokingDeviceIds}
            />
          ) : (
            <HeroFlow
              stepIdx={stepIdx}
              platform={platform}
              onPlatformChange={setPlatform}
              installQrUrl={installQrUrl}
              installCopy={getInstallCopy(platform, iosChannel)}
              iosChannel={iosChannel}
              onIosChannelChange={setIosChannel}
              onOpenAndroidInstallGuide={openAndroidInstallGuide}
              onOpenInstallUrl={openInstallUrl}
              onCopyInstallUrl={copyInstallUrl}
              pairQrDataUrl={pairQrDataUrl}
              pairQrSize={pairQrSize}
              pairingUrl={pairingUrl}
              pairingQrError={pairingQrError}
              relayMintFailure={relayMintFailure}
              onUseLan={onUseLan}
              onRetryRelay={onRetryRelay}
              onCopyRelayDiagnostics={onCopyRelayDiagnostics}
              pairLoading={pairLoading}
              connectionMode={connectionMode}
              onConnectionModeChange={handleConnectionModeChange}
              onRegeneratePairing={() => generatePairing(true)}
              canGeneratePairing={canGeneratePairing}
              onCopyPairingCode={copyPairingCode}
              networkInterfaces={networkInterfaces}
              customAddresses={customAddresses}
              selectedAddress={selectedAddress}
              selectedAddressIsCustom={selectedAddressIsCustom}
              onSelectedAddressChange={handleAddressChange}
              onCustomAddressSelect={onCustomAddressSelect}
              onCustomAddressRemove={onCustomAddressRemove}
              beforeCustomAddressChange={beforeCustomAddressChange}
              onRefreshNetworkInterfaces={loadNetworkInterfaces}
              refreshingNetworkInterfaces={refreshingNetworkInterfaces}
              onBack={handleBack}
              onContinue={handleContinue}
              onDone={devices.length > 0 ? () => showPairedDevices(devices.length) : undefined}
            />
          )}
        </div>

        <div
          className="mp-stage"
          aria-label={translate('auto.components.mobile.MobilePage.e17393c6a3', 'Phone preview')}
          data-host-mode={hostStatus?.hostMode ?? 'unknown'}
        >
          <PhoneCarousel />
        </div>
      </section>
    </div>
  )
}
