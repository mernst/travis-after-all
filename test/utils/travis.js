import wait from './wait';
import { getJSON } from './get';

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

// Travis CI API URLs
// http://docs.travis-ci.com/api/

const TRAVIS_API_BUILD_URL = 'https://api.travis-ci.org/builds/';
const TRAVIS_API_BUILDS_URL = `https://api.travis-ci.org/repositories/{{REPOSITORY_NAME}}/builds`;
const TRAVIS_API_JOBS_URL = 'https://api.travis-ci.org/jobs/';

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

// Travis CI set environment variables
// http://docs.travis-ci.com/user/environment-variables/#Default-Environment-Variables

const TRAVIS_CURRENT_BUILD_ID = parseInt(process.env.TRAVIS_BUILD_ID, 10);
const TRAVIS_CURRENT_BUILD_NUMBER = parseInt(process.env.TRAVIS_BUILD_NUMBER, 10);
const TRAVIS_CURRENT_JOB_ID = parseInt(process.env.TRAVIS_JOB_ID, 10);

const TRAVIS_BRANCH_NAME = `${process.env.TRAVIS_BRANCH}`;
const TRAVIS_PULL_REQUEST = `${process.env.TRAVIS_PULL_REQUEST}`;

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

const CHECK_INTERVAL = 20000;

// ---------------------------------------------------------------------

const getBranchName = () =>
    TRAVIS_BRANCH_NAME;

const getBuildID = async (repositoryName, branchName) => {

    const BUILDS_URL = TRAVIS_API_BUILDS_URL.replace('{{REPOSITORY_NAME}}', repositoryName);
    const BUILD_NUMBER = TRAVIS_CURRENT_BUILD_NUMBER;

    let buildID = null;
    let url = BUILDS_URL;

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    do {

        let builds;
        let lastBuildNumber;

        builds = await getJSON(url);

        for ( let i = 0; i < builds.length; i++ ) {
            if ( builds[i].branch.indexOf(branchName) !== -1 ) {
                buildID = builds[i].id;
                break;
            }
        }

        lastBuildNumber = parseInt(builds[builds.length - 1].number, 10);


        // If buildID was not found, that means that eaither:

        if ( buildID === null ) {


            // 1) The git push was not yet picked up by Travis CI
            //    so we need to wait a little bit and then try again

            if ( lastBuildNumber <= BUILD_NUMBER ) {

                url = BUILDS_URL;
                await wait(CHECK_INTERVAL);


            // 2) The build is not in the current page of 25 builds
            //    provide by the API, so we need to move the next page

            } else {
                url = `${BUILDS_URL}?after_number=${lastBuildNumber}`;
            }

        }

    } while ( buildID === null );

    return buildID;

};

const getBuildData = (buildID) =>
    getJSON(`${TRAVIS_API_BUILD_URL}${buildID}`);

const getCurrentBuildID = () =>
    TRAVIS_CURRENT_BUILD_ID;

const getCurrentBuildNumber = () =>
    TRAVIS_CURRENT_BUILD_NUMBER;

const getCurrentJobID = () =>
    TRAVIS_CURRENT_JOB_ID;

const getFinalData = async (url, waitingMsg) => {

    let data;

    do {

        if ( data !== undefined ) {
            console.log(waitingMsg);
            await wait(CHECK_INTERVAL);
        }

        data = await getJSON(url);

    } while ( data.state !== 'finished' );

    return data;

};

const getFinalBuildData = (buildID) =>
    getFinalData(
        `${TRAVIS_API_BUILD_URL}${buildID}`,
        `Waiting for build '${buildID}' to finish...`
    );

const getFinalJobData = async (jobID) =>
    getFinalData(
        `${TRAVIS_API_JOBS_URL}${jobID}`,
        `Waiting for job '${jobID}' to finish...`
    );

const isPullRequest = () =>
    TRAVIS_PULL_REQUEST !== 'false';

// ---------------------------------------------------------------------

export default {
    getBranchName: getBranchName,
    getBuildData: getBuildData,
    getBuildID: getBuildID,
    getCurrentBuildID: getCurrentBuildID,
    getCurrentBuildNumber: getCurrentBuildNumber,
    getCurrentJobID: getCurrentJobID,
    getFinalBuildData: getFinalBuildData,
    getFinalJobData: getFinalJobData,
    isPullRequest: isPullRequest
};