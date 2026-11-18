# VM deployment plans

`buildVmDeployment` assembles launch, snapshot, rollback, and destroy plans. It performs no deployment and returns `status: unsupported` until a signed-image verifier, snapshot backend, rollback drill, and network isolation have been independently verified on the target host.
