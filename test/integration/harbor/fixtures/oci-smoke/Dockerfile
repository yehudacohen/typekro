FROM busybox:1.37.0

COPY proof.txt /proof.txt

ENTRYPOINT ["/bin/sh", "-c", "test \"$(cat /proof.txt)\" = typekro-harbor-oci-proof"]
