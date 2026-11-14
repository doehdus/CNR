/*
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#define N 256
#define HOP 64
#define NOISE_FRAMES 5
#define RATE 16000
#define ALPHA 1.55
#define MIN_GAIN 0.16
#define SS_POWER 2.0
#define PI 3.14159265358979323846

typedef struct { double re, im; } Complex;

static void fft(Complex *a, int inverse) {
    for (unsigned i=1,j=0;i<N;i++) {
        unsigned bit=N>>1;
        for (;j&bit;bit>>=1) j^=bit;
        j^=bit;
        if(i<j) { Complex t=a[i];a[i]=a[j];a[j]=t; }
    }
    for(unsigned len=2;len<=N;len<<=1) {
        double angle=(inverse?2.0:-2.0)*PI/len;
        Complex step={cos(angle),sin(angle)};
        for(unsigned i=0;i<N;i+=len) {
            Complex w={1,0};
            for(unsigned j=0;j<len/2;j++) {
                Complex u=a[i+j],v=a[i+j+len/2];
                Complex t={v.re*w.re-v.im*w.im,v.re*w.im+v.im*w.re};
                a[i+j]=(Complex){u.re+t.re,u.im+t.im};
                a[i+j+len/2]=(Complex){u.re-t.re,u.im-t.im};
                w=(Complex){w.re*step.re-w.im*step.im,w.re*step.im+w.im*step.re};
            }
        }
    }
    if(inverse) for(int i=0;i<N;i++){a[i].re/=N;a[i].im/=N;}
}
static void put16(FILE *f,uint16_t v){fputc(v&255,f);fputc((v>>8)&255,f);}
static void put32(FILE *f,uint32_t v){put16(f,(uint16_t)v);put16(f,(uint16_t)(v>>16));}

static int save_wav(const char *name,const double *x,size_t count,size_t *clipped) {
    if(count>(UINT32_MAX-36u)/2u)return 0;
    FILE *f=fopen(name,"wb");if(!f)return 0;
    fwrite("RIFF",1,4,f);put32(f,36u+(uint32_t)(2*count));fwrite("WAVEfmt ",1,8,f);
    put32(f,16);put16(f,1);put16(f,1);put32(f,RATE);put32(f,RATE*2);
    put16(f,2);put16(f,16);fwrite("data",1,4,f);put32(f,(uint32_t)(2*count));
    *clipped=0;
    for(size_t i=0;i<count;i++) {
        double v=x[i];
        if(v>32767){v=32767;(*clipped)++;}
        if(v< -32768){v= -32768;(*clipped)++;}
        put16(f,(uint16_t)(int16_t)lrint(v));
    }
    int ok=!ferror(f);if(fclose(f)!=0)ok=0;return ok;
}
int main(int argc,char **argv) {
    if(argc!=3){fprintf(stderr,"Usage: %s input.raw output.wav\n",argv[0]);return 1;}
    if(!strcmp(argv[1],argv[2])){fprintf(stderr,"Input and output must differ\n");return 1;}

    FILE *f=fopen(argv[1],"rb");if(!f){perror(argv[1]);return 1;}
    if(fseek(f,0,SEEK_END)!=0){fclose(f);return 1;}long bytes=ftell(f);
    if(bytes<NOISE_FRAMES*N*2 || bytes%2){fprintf(stderr,"Input must contain at least 1280 signed 16-bit samples\n");fclose(f);return 1;}
    rewind(f);size_t count=(size_t)bytes/2;
    unsigned char *raw=malloc((size_t)bytes);double *x=calloc(count,sizeof(double));
    double *out=calloc(count,sizeof(double)),*weight=calloc(count,sizeof(double));
    if(!raw||!x||!out||!weight){fprintf(stderr,"Out of memory\n");free(raw);free(x);free(out);free(weight);fclose(f);return 1;}
    size_t got=fread(raw,1,(size_t)bytes,f);fclose(f);
    if(got!=(size_t)bytes){fprintf(stderr,"Input read failed\n");free(raw);free(x);free(out);free(weight);return 1;}
    if(bytes>=12 && !memcmp(raw,"RIFF",4)&&!memcmp(raw+8,"WAVE",4)){fprintf(stderr,"Input must be headerless RAW, not WAV\n");free(raw);free(x);free(out);free(weight);return 1;}
    for(size_t i=0;i<count;i++){unsigned u=raw[2*i]|((unsigned)raw[2*i+1]<<8);x[i]=(u<32768)?(double)u:(double)((int)u-65536);}
    free(raw);
    double window[N],noise[N]={0};Complex a[N];
    for(int j=0;j<N;j++)window[j]=sqrt(0.5-0.5*cos(2*PI*j/N));

    for(int frame=0;frame<NOISE_FRAMES;frame++) {
        for(int j=0;j<N;j++)a[j]=(Complex){x[frame*N+j]*window[j],0};
        fft(a,0);
        for(int k=0;k<N;k++)noise[k]+=(a[k].re*a[k].re+a[k].im*a[k].im)/NOISE_FRAMES;
    }

    {
        double smoothed[N];int radius=1;
        for(int k=0;k<=N/2;k++){
            double sum=0,weights=0;
            for(int j=-radius;j<=radius;j++){
                int q=k+j;if(q<0)q=-q;if(q>N/2)q=N-q;
                double w=(double)(radius+1-abs(j));sum+=w*noise[q];weights+=w;
            }
            smoothed[k]=sum/weights;
        }
        for(int k=0;k<N;k++)noise[k]=smoothed[k<=N/2?k:N-k];
    }
    double previous_gain[N/2+1];
    for(int k=0;k<=N/2;k++)previous_gain[k]=MIN_GAIN;

    for(long start=-(N-HOP);start<(long)count;start+=HOP) {
        for(int j=0;j<N;j++){long t=start+j;a[j]=(Complex){(t>=0&&t<(long)count?x[t]:0)*window[j],0};}
        fft(a,0);
        double filtered[N/2+1];
        for(int k=0;k<=N/2;k++){
            double power=a[k].re*a[k].re+a[k].im*a[k].im;
            double magnitude=sqrt(power);

            double residual_power=fmax(pow(magnitude,SS_POWER)-pow(ALPHA*sqrt(noise[k]),SS_POWER),pow(MIN_GAIN*magnitude,SS_POWER));
            double residual=pow(residual_power,1.0/SS_POWER);
            double gain=magnitude>0?residual/magnitude:0;

            double memory=gain>previous_gain[k]?0.48:0.78;
            gain=memory*previous_gain[k]+(1-memory)*gain;
            filtered[k]=gain;previous_gain[k]=gain;
        }
        for(int k=0;k<N;k++){
            int bin = k <= N/2 ? k : N-k;
            double gain = 0.0;
            for (int offset = -4; offset <= 4; offset++) {
                int neighbor = bin + offset;
                if (neighbor < 0) neighbor = -neighbor;
                if (neighbor > N/2) neighbor = N-neighbor;
                gain += (5-abs(offset)) * filtered[neighbor];
            }
            gain /= 25.0;
            a[k].re*=gain;a[k].im*=gain;
        }

        fft(a,1);
        for(int j=0;j<N;j++){long t=start+j;if(t>=0&&t<(long)count){out[t]+=a[j].re*window[j];weight[t]+=window[j]*window[j];}}
    }

    for(size_t i=0;i<count;i++)out[i]=weight[i]>1e-12?out[i]/weight[i]:0;
    size_t clipped=0;int ok=save_wav(argv[2],out,count,&clipped);
    if(!ok)perror(argv[2]);
    else printf("%zu samples, %d Hz, mono, 16-bit, %.7f s; alpha=%.3f min_gain=%.4f; clipped=%zu\n",count,RATE,(double)count/RATE,ALPHA,MIN_GAIN,clipped);
    free(x);free(out);free(weight);return ok?0:1;
} */