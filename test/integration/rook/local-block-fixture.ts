import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { job } from '../../../src/factories/kubernetes/workloads/job.js';
import { persistentVolume } from '../../../src/factories/kubernetes/storage/persistent-volume.js';
import { storageClass } from '../../../src/factories/kubernetes/storage/storage-class.js';

export interface OrbStackLocalBlockFixtureOptions {
  name: string;
  namespace: string;
  nodeName: string;
  loopDeviceNumber: number;
  storageClassName: string;
  persistentVolumeName: string;
  capacity: string;
  hostDataDirectory?: string;
  image?: string;
}

/**
 * A deliberately test-only raw-block fixture for OrbStack.
 *
 * Rook requires a real block device with a host udev record. The CSI hostpath
 * driver's Block volumes are loop devices created without that record, so
 * ceph-volume rejects them. This fixture creates one bounded, dedicated host
 * loop device, then exposes it through a static Local PersistentVolume. It is
 * not a production storage profile and must never be selected automatically by
 * a TypeKro composition.
 */
export function createOrbStackLocalBlockFixture(options: OrbStackLocalBlockFixtureOptions) {
  const capacityMatch = /^([1-9][0-9]*)Gi$/.exec(options.capacity);
  if (!capacityMatch?.[1]) {
    throw new Error(
      `OrbStack local-block fixture capacity must be a positive whole Gi value; received ${options.capacity}`
    );
  }
  const hostDataDirectory = options.hostDataDirectory ?? '/var/lib/typekro-local-block';
  const image = options.image ?? 'quay.io/ceph/ceph:v20.2.2';
  const devicePath = `/dev/loop${options.loopDeviceNumber}`;
  const hostBackingFile = `${hostDataDirectory}/${options.name}.img`;
  const mountedBackingFile = `/host-data/${options.name}.img`;
  const backingFileSize = `${capacityMatch[1]}G`;
  const status = type({
    ready: 'boolean',
    storageClassName: 'string',
    persistentVolumeName: 'string',
    devicePath: 'string',
  });

  const prepare = kubernetesComposition(
    {
      name: `${options.name}-prepare`,
      kind: 'OrbStackLocalBlockPreparation',
      spec: type({ name: 'string' }),
      status,
    },
    () => {
      const prepareJob = job({
        id: 'prepareJob',
        metadata: {
          name: `${options.name}-prepare`,
          namespace: options.namespace,
          labels: { 'typekro.dev/test-fixture': 'orbstack-local-block' },
        },
        spec: {
          backoffLimit: 1,
          template: {
            metadata: { labels: { 'typekro.dev/test-fixture': 'orbstack-local-block' } },
            spec: {
              nodeName: options.nodeName,
              restartPolicy: 'Never',
              containers: [
                {
                  name: 'prepare',
                  image,
                  securityContext: { privileged: true, runAsUser: 0 },
                  command: ['/bin/sh', '-ec'],
                  args: [
                    `set -eu
device='${devicePath}'
backing='${mountedBackingFile}'
if [ ! -b "$device" ]; then
  mknod "$device" b 7 '${options.loopDeviceNumber}'
fi
attached="$(losetup -n -O BACK-FILE "$device" 2>/dev/null | xargs || true)"
if [ -n "$attached" ]; then
  case "$attached" in
    *'/${options.name}.img') ;;
    *) echo "refusing to reuse $device attached to $attached" >&2; exit 1 ;;
  esac
else
  truncate -s '${backingFileSize}' "$backing"
  losetup "$device" "$backing"
fi
wipefs --all --force "$device"
dd if=/dev/zero of="$device" bs=1M count=16 conv=fsync
blockdev --rereadpt "$device" || true
udevadm trigger --action=change --subsystem-match=block
udevadm settle --timeout=30
mkdir -p /run/udev/data
find -L /sys/block -name dev -type f | while IFS= read -r dev_file; do
  block_sys_device="\${dev_file%/dev}"
  major_minor="$(cat "$dev_file")"
  udev_record="/run/udev/data/b$major_minor"
  if [ ! -s "$udev_record" ]; then
    temporary_record="$udev_record.typekro.$$"
    {
      printf 'I:0\n'
      udevadm info --query=property --path="$block_sys_device" | sed 's/^/E:/'
      printf 'G:systemd\nQ:systemd\nV:1\n'
    } > "$temporary_record"
    chmod 0644 "$temporary_record"
    mv "$temporary_record" "$udev_record"
  fi
  test -s "$udev_record"
done
udev_properties="$(udevadm info --query=property --path='/sys/block/loop${options.loopDeviceNumber}')"
printf '%s\n' "$udev_properties"
printf '%s\n' "$udev_properties" | grep -Fx 'DEVNAME=${devicePath}'
test -s '/run/udev/data/b7:${options.loopDeviceNumber}'`,
                  ],
                  volumeMounts: [
                    { name: 'dev', mountPath: '/dev' },
                    { name: 'sys', mountPath: '/sys' },
                    { name: 'udev', mountPath: '/run/udev' },
                    { name: 'data', mountPath: '/host-data' },
                  ],
                },
              ],
              volumes: [
                { name: 'dev', hostPath: { path: '/dev', type: 'Directory' } },
                { name: 'sys', hostPath: { path: '/sys', type: 'Directory' } },
                { name: 'udev', hostPath: { path: '/run/udev', type: 'Directory' } },
                {
                  name: 'data',
                  hostPath: { path: hostDataDirectory, type: 'DirectoryOrCreate' },
                },
              ],
            },
          },
        },
      });
      const blockStorageClass = storageClass({
        id: 'storageClass',
        metadata: {
          name: options.storageClassName,
          labels: { 'typekro.dev/test-fixture': 'orbstack-local-block' },
        },
        provisioner: 'kubernetes.io/no-provisioner',
        reclaimPolicy: 'Retain',
        volumeBindingMode: 'WaitForFirstConsumer',
      });
      blockStorageClass.dependsOn(prepareJob);
      const blockVolume = persistentVolume({
        id: 'persistentVolume',
        metadata: {
          name: options.persistentVolumeName,
          labels: { 'typekro.dev/test-fixture': 'orbstack-local-block' },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          capacity: { storage: options.capacity },
          local: { path: devicePath },
          nodeAffinity: {
            required: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [
                    {
                      key: 'kubernetes.io/hostname',
                      operator: 'In',
                      values: [options.nodeName],
                    },
                  ],
                },
              ],
            },
          },
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: options.storageClassName,
          volumeMode: 'Block',
        },
      });
      blockVolume.dependsOn(blockStorageClass);
      return {
        ready: prepareJob.status.succeeded === 1,
        storageClassName: options.storageClassName,
        persistentVolumeName: options.persistentVolumeName,
        devicePath,
      };
    }
  );

  const cleanup = kubernetesComposition(
    {
      name: `${options.name}-cleanup`,
      kind: 'OrbStackLocalBlockCleanup',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean', devicePath: 'string' }),
    },
    () => {
      const cleanupJob = job({
        id: 'cleanupJob',
        metadata: {
          name: `${options.name}-cleanup`,
          namespace: options.namespace,
          labels: { 'typekro.dev/test-fixture': 'orbstack-local-block' },
        },
        spec: {
          backoffLimit: 1,
          template: {
            metadata: { labels: { 'typekro.dev/test-fixture': 'orbstack-local-block' } },
            spec: {
              nodeName: options.nodeName,
              restartPolicy: 'Never',
              containers: [
                {
                  name: 'cleanup',
                  image,
                  securityContext: { privileged: true, runAsUser: 0 },
                  command: ['/bin/sh', '-ec'],
                  args: [
                    `set -eu
device='${devicePath}'
backing='${mountedBackingFile}'
if losetup "$device" >/dev/null 2>&1; then
  attached="$(losetup -n -O BACK-FILE "$device" | xargs)"
  case "$attached" in
    *'/${options.name}.img') losetup -d "$device" ;;
    *) echo "refusing to detach $device attached to $attached" >&2; exit 1 ;;
  esac
fi
rm -f "$backing"`,
                  ],
                  volumeMounts: [
                    { name: 'dev', mountPath: '/dev' },
                    { name: 'data', mountPath: '/host-data' },
                  ],
                },
              ],
              volumes: [
                { name: 'dev', hostPath: { path: '/dev', type: 'Directory' } },
                {
                  name: 'data',
                  hostPath: { path: hostDataDirectory, type: 'DirectoryOrCreate' },
                },
              ],
            },
          },
        },
      });
      return { ready: cleanupJob.status.succeeded === 1, devicePath };
    }
  );

  return {
    prepare,
    cleanup,
    devicePath,
    hostBackingFile,
    storageClassName: options.storageClassName,
    persistentVolumeName: options.persistentVolumeName,
  };
}
