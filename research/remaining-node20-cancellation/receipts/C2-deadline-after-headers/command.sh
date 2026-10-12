bash -c bun\ --version\ \&\&\ bun\ test\ --isolate\ packages/core/src/fetch-timeout.test.ts\ -t\ \"does\ not\ let\ the\ expired\ header\ deadline\|preserves\ metadata\,\ clone\ metadata\" 
